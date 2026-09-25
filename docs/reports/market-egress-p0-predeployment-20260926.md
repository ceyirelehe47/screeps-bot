# 市场出货 P0：现役核对、动态底价与上线前验收

## 只读基线

2026-09-25 19:18 UTC 的 `npm run monitor:once` 选中 `shard1`，tick `73941370`。线上 `Memory.runtime.lastDeployTag` 为 `2026.8.29-6+5cef62c@2026-09-24T15:04:28.806Z`；另经只读 `/api/user/code` 核对默认模块 `main` 的 SHA-256 为 `62a993bf917f1a74ef708584eaee1fc3d2deb5aaf8b0c751f8f9d72ff3c08032`。本热修从现役提交 `5cef62c5` 建立，未将 Treasury 或 Observer/PowerBank 候选合入。远端 `origin` 指向 `ceyirelehe47/screeps-bot`，读取时其 `main` 为 `a0fae1f0`；该远端分支领先现役部署，不代表这些提交已经上线。

当次 `ResourceControl` 统计如下，容量是 storage / terminal 的剩余单位；主库存是稍后约 19:21 UTC 的只读 room-objects 结果，时间口径不同，不以其微小差值推断趋势。

| 房间 | 状态 | storage 空位 | terminal 空位 | 主要过剩库存（storage；terminal） |
| --- | --- | ---: | ---: | --- |
| E1N57 | emergency | 5,049 | 0 | Energy 425k、X 262k、L 167k；Energy 146k、X 66k、L 27k |
| E3N59 | pressure | 151,248 | 24,430 | Energy 255k、K 144k、H 127k、L 112k；Energy 259k |
| E4N58 Hub | emergency | 0 | 0 | Energy 1.46m、X 2.93m、K 1.11m、L 890k、Z 641k；Energy 288k |
| E5N59 | emergency | 794 | 0 | Energy 410k、U 192k、K 155k、L 137k；Energy 272k、U 25k |
| E6N59 | emergency | 3,191 | 0 | Energy 415k、K 80k、X 71k、L 63k；Energy 241k、O 47k、X 0 |
| E7N57 | emergency | 0 | 0 | Energy 411k、Z 182k、L 169k、K 115k；Energy 289k |
| E7N58 | emergency | 0 | 69,784 | Energy 407k、K 179k、L 174k；Energy 206k、L 15k |
| W1N57 | pressure | 82,090 | 39,851 | Energy 345k、K 237k、L 105k；Energy 186k、Z 37k |

与 2026-09-24 16:49 UTC 的上一个可比快照相隔 **26.48 小时**：八房合计空位 `1,795,260 → 376,437`，减少 `1,418,823`；storage+terminal Energy `4,585,515 → 6,012,110`，增加 `1,426,595`。这说明净 Energy 流入足以解释大部分空位损失；不是一小时变化率。当前六房 emergency、两房 pressure。

## 市场事实与故障分类

- 请求与生效均为 `direct`，配置 revision `market-base-resource-v3-r3`，V3 共有八房七资源、56 条 lane。只有 `E6N59:X` 持有 `canary/enabled` 新成交签名，其余 lane 均为 suspended。旧 ResourceControl market seller 关闭，热修不启用第二个写入者。
- V3 WAL 的 `pending=null`、quarantine=0、blocker=null；累计六笔已确认 X 成交，每笔 1,000。通过只读 money-history 核对，最近真实市场交易仍在 **2026-07-27**，价格约 683.814，本次调查没有执行市场动作。已确认历史与「近期正在出货」是两件事。
- 当前 V3 单笔计划 1,000，全局滚动额度每 30,000 tick 12,000；room 5,000、lane 3,000，X 资源上限 8,000，确认后冷却 1,000 tick。监控里的 V3 quota 为 `null`，不能把旧 V2 的 quota 数字冒充当前实时可用额度。签名与规则共同决定有效额度，不能因看到 12,000 就假定所有房间可卖。
- 最新完整 V3 planning（tick `73941369`）读到 40 个原始买单、0 个满足当轮资源与最小名义金额等条件的订单，`selected=null`、`blocker=null`；该轮抽样的 shadow 资源是 O，不代表 X 全市场无买单。现役 X 买价约 443.666 低于旧 X 硬底价 480 和旧最小订单名义额 480,000；这是价格和订单筛选缺口。`market_base_v3_not_full_planning_tick` 是调度诊断，不是完整 planning 故障。
- ResourceControl 有 24 个内部 pending 转运任务，23 个 `receiver_capacity`、1 个 `source_depleted`。这是另一类容量/库存阻断；热修不清空任务或保护账本。V3 保护后可售余量为零、终端货物不足、没有达到净价的买单、程序/证据故障，须分别报告。

## 定价修正与安全边界

重新读取 Screeps 市场 `GET /api/game/market/stats` 的最近 14 个完整交易日（截至 2026-09-24），以日均价的 p25 为新标定依据：`economic=min(旧值, ceil(p25×0.90))`，`hard=min(旧值, ceil(economic×0.95))`。这是有市场证据的静态安全下界；保护库存没有下降。实时 Direct 净价地板在此之上按以下式子更新：

`max(hard, min(历史棘轮, 买单最优可执行价 EMA × [1−0.15×库存压力因子]))`；库存压力由**保护后 storage+terminal 可售盈余**相对 lane 滚动量计算，因子在 0–1 内。最终地板再取 `max(economic, 动态值)`，单个市场日最多下移 15%。EMA 无可信可执行买单时回退历史棘轮，绝不以空订单簿制造低价。交易还需通过原有净价、手续费、Energy、保护余量、permit、WAL 和二次读取检查。

| 资源 | 14 日 p25 | 旧 hard/economic | 新 hard/economic | 当时最好买价约数 | 价格判断 |
| --- | ---: | ---: | ---: | ---: | --- |
| H | 609.405 | 428 / 451 | 428 / 451 | 571 | 需逐单扣手续费 |
| K | 37.623 | 96 / 101 | 33 / 34 | 37.294 | 旧硬底价明显脱市 |
| L | 546.789 | 161 / 169 | 161 / 169 | 279 | 动态值仍须逐单核算 |
| O | 81.802 | 138 / 145 | 71 / 74 | 24.613 | 买价过低，不能为成交继续降底价 |
| U | 34.920 | 44 / 46 | 31 / 32 | 30.666 | 当时报价低于经济底价 |
| X | 433.099 | 480 / 480 | 371 / 390 | 443.666 | 高库存时可进入净价候选 |
| Z | 62.857 | 43 / 45 | 43 / 45 | 59.063 | 需逐单扣手续费 |

订单簿报价会变化，上表不是成交承诺。每条 lane 的 100,000 保护储备、生产/防御预留、未决交易、预约与已有确认均原样参与计算。历史异常日使可信日期回退时，仅在被剔除日期仍可验证为离群日的情况下沿用已签名较新棘轮，其他不完整证据仍拒绝成交。

## 同一出货链路的代码处理

1. V3 继续由既有保护账本计算可售余量；动态定价读取 storage+terminal 总盈余，执行时仍要求 terminal 实货，不将仓库库存当作已经装车。
2. 已签名的 V3 lane 派生当 tick 货物准备授权。ResourceControl 只在已有 carrier task board 上为一批货腾挪 Energy，再把不超过单笔 1,000 的矿物从 storage 运到 terminal；出货侧仅使用物理空位，普通入库的 80k terminal / 200k storage 安全余量不套用到出货。备货任务用原 carrier amount slice 和目标容量 claim 限制同 tick 多 carrier，下一 tick 从目标中扣除已取货在途量，避免同一批重复搬运。既有预约、费用 Energy 与保护余量照常扣除。
3. 市场执行、未知结果等待、交易对账、额度和空位回收仍由原 V3 writer / WAL 负责。没有新建卖货 writer；无法确认执行结果时先对账，不重复发单。
4. 当 ResourceControl 本 tick 判定 pressure/emergency，且 storage Energy 已达目标、terminal Energy 满足储备、房间可用 Energy 至少半满时，暂停本地及远矿新增 Energy 采集；容量恢复或防御/生产 Energy 低于条件时自动恢复。此举限制卖出后被无谓净流入立刻补满。
5. 旧 r3 签名中 `E6N59:X` canary 仍 armed。迁移现在允许在**同一 lane、相同执行额度/保护参数、相同授权状态**下重签价格策略，保留 WAL receipt head 与累计确认；新 lane、增加额度或改房间不能走此通道。需要正式上线时，按既有 `cfg → proposeMarketBaseResourcePolicyMigration → acceptMarketBaseResourcePermit` 两步协议读回，不覆盖 pending。

## 验证与尚未完成的生产验收

基于现役提交的热修在本地通过 `npm run typecheck`、`npm run build` 和受影响 Jest 套件。当前构建 `dist/main.js` 约 4.51 MB，低于 5 MB；它是工作树构建，正式上传前需在提交后重新构建并按字节读回。回归覆盖 r3 旧字段与 armed X canary 迁移、库存和市场底价、storage-only 盈余不越权成交、满 terminal 腾挪/备货、同 tick 与跨 tick 多 carrier 限额、保护与容量退化。

**目前尚未部署，也未产生本轮真实出货。** 验收须读回 shard1 模块与 runtime 身份，核对 cfg/permit/WAL，再按授权逐 lane 放行。持续采样真实 outgoing transactions、各房 storage+terminal 空位、Energy 净流入与保护储备；至少要证明多个时段的净出货及空位恢复趋势，不能用日志条数或单笔 1,000 成交结案。若全局每 30,000 tick 12,000 的额度仍不足以抵消新流入，应另行审查原 writer 的额度升级；不得通过清 pending、降低保护储备或绕开 permit 扩量。
