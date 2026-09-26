# G1 市场 R2：shard1 有界试运行与提前退出

## 结果

用户在本任务中直接批准一次 G1 正式灰度后，从 `codex/market-egress-r2` 干净提交 `f69f79967853d6583bfe1178ebcb2ae5d562dd7e` 向 `screeps.com/default/shard1` 上传唯一候选。实际 `main` 为 4,558,659 字节、SHA-256 `0f13b0c4814686567e7ed3c72a3c22376a6b22ae304e02b3c17858763cfe0a4f`，独立 GET 与本地完全一致；运行标签为 `2026.8.29-6+f69f799@2026-09-26T12:48:09.938Z`。既有 cfg 从 r6 升为 r7，经 `proposeMarketBaseResourcePolicyMigration → acceptMarketBaseResourcePermit` 将 permit epoch 16→17；X/L continuous 签名冷却 100 tick，H canary 仍 1,000 tick。旧 receipt head、finalizedSeq=15 和 `notBefore=73958767` 保留。

唯一试运行 `market-base-egress-r2-2026-09-26` 在 tick `73958367` 启动，固定截止 tick `73961367` 或 2026-09-26 14:06:30 UTC，以先到者为准。`notBefore=73958767` 没有倒拨。外部观察者完成 118 次有读回的心跳，operation ID 无重复；在约 13:46 UTC，因两条候选房间容量均恢复 `normal`，游戏内状态自动变为 `closed/capacity_recovered`，观察者随即退出。本实例 **0 次新增 native 调用、0 计划/确认数量、0 市场手续费 Energy、0 市场 credits 入账、0 经济净价**。原 V3 receipt head 仍为 `csh1:8ca735c4bdcdce158e8a379e175f4a5b`，无 pending/quarantine，最终代码与 cfg/permit 身份正确，Direct 规划仍完整。关闭的主镜像一致且同一 run 不能重新启动。

这证明了上线、协议迁移、原冷却保留、观察者控制与容量恢复退出；**没有证明线上 100 tick 连续成交吞吐**。退出约八分钟后的 tick `73959008`，Direct 市场仍完整规划、无 blocker，试运行保持关闭，说明退出没有永久关闭原市场。此时尚无新一笔市场成交，不能用静态回归冒充线上恢复 1,000 tick 的实际后继间隔。旧 r6 在本实例之前自主完成的第 13–15 笔见 [上线前报告](market-egress-R2-20260926.md)，不计入本次额度。

## 逐动作与读回

| 阶段 | 原始结果 |
| --- | --- |
| 上线前 | 12:46 UTC：旧代码 SHA-256 `13d3c5e698c5ef8d60bb1d0baf5420d9e3081c040494343ff3a1080fbabf2caa`；r6/epoch16，receipt head 如上，pending/quarantine 0；E4N58:X、E1N57:L 仍 continuous，E3N59:H 仍 canary。console 探针确认 shard1。 |
| 上传 | 一次 `npm run push`；API 回读 4,558,659 字节与本地一致。 |
| cfg | 一次有源状态与部署标签守卫的 console 写入，operation ID `6ab7bf41dcb0870013673081`；读回仅版本 r7，permit 与账本未动。 |
| proposal | operation ID `6ab7bf63dcb087001367308a`；持久 proposal `csh1:9fcaa2f4052093c97cecf29a95017277`，目标 epoch17、receipt head 未变。 |
| accept | 对精确 proposal ID 一次接受，operation ID `6ab7bf824086a30013e9f09a`；读回 epoch17，X/L 100、H 1,000，旧 WAL 原样保留。 |
| trial | 一次受旧 receipt head、permit、压力状态和部署标签守卫的启动，operation ID `6ab7c355dcb0870013673201`；主镜像读回 active、0 次、原 `notBefore`。 |
| 退出 | 观察者末尾为 `closed/capacity_recovered`；最终只读 API 再确认主镜像、WAL、money-history 和现役代码。没有恢复旧二进制或覆盖历史 Memory。 |

## 首笔被挡的真实原因

旧冷却在 tick `73958767` 越过后，V3 仍完整读到买单，但没有可执行订单。tick `73958777`、`73958817` 的候选明确给 E4N58:X `sellableAmount=0`、`direct_terminal_stock_shortage`。只读房间对象在 13:46 UTC 显示 E4N58 Storage **2,942,223 X**，Terminal **0 X**；Terminal Energy 54,048、容量 300,000，故当时缺的是待售矿物的终端实货，不是总库存、终端空位或手续费 Energy。E1N57:L 有保护后余量，但其房间已变为 `normal`，不具备本轮短冷却资格。

ResourceControl 在上述窗口为 E4N58 接纳了一笔 UH 内部 staging 批次（2,128 单位），还有其他转运任务等待。现役代码仅在该房没有 staging 批次时生成市场货物目标；这与 X 未进入 Terminal 的持续观察相符，但单凭两次快照不能证明此竞争会无限持续。本轮没有注入人工搬运、降低底价/储备、提升 H canary 或热换第二份生产代码。**终端 X 备货窗口竞争仍是后续真实吞吐的待修复/复核项。**

## 逐房容量与经济口径

同一只读监控口径的端点为 tick `73958450`（13:12 UTC）和 `73958925`（13:47 UTC），覆盖试运行后大部分窗口。每房容量固定；表中 used/free 均为 Storage+Terminal，单位为资源量。

| 房间 | 起始状态 | 起始 used / free | 结束状态 | 结束 used / free | free 变化 |
| --- | --- | ---: | --- | ---: | ---: |
| E1N57 | pressure | 890,041 / 409,959 | normal | 965,742 / 334,258 | -75,701 |
| E3N59 | normal | 1,060,375 / 239,625 | normal | 1,064,735 / 235,265 | -4,360 |
| E4N58 | pressure | 7,982,779 / 317,221 | normal | 7,908,904 / 391,096 | +73,875 |
| E5N59 | normal | 1,055,181 / 244,819 | normal | 1,044,599 / 255,401 | +10,582 |
| E6N59 | normal | 1,099,248 / 200,752 | normal | 1,109,697 / 190,303 | -10,449 |
| E7N57 | normal | 1,081,839 / 218,161 | normal | 1,087,863 / 212,137 | -6,024 |
| E7N58 | pressure | 872,297 / 427,703 | normal | 837,498 / 462,502 | +34,799 |
| W1N57 | normal | 1,067,544 / 232,456 | normal | 1,070,218 / 229,782 | -2,674 |

八房总 free 在该窗口增加 20,048，容量总量未变；末端八房均 `normal`。但本实例没有市场成交，E4N58 的 X 在两个资源快照中仍为 2,942,223，故不能把空位改善归因于矿物外售。内部转运、生产与 Energy 消耗混在 used/free 变化中；本短窗不证明长期积压已清理。试运行前 r6 最近四笔的 money-history 实际现金收入合计 1,441,574 credits、手续费合计 3,087 Energy；相应 receipt 的经济净价合计 1,333,254.257 credits，二者的差额是 Energy 影子估值，**并非另一次实际 credits 扣款**。上述四笔均发生在本实例之前。

## 可复核原件

原始 API 读回、监控快照、money-history、房间 Store、观察者 JSONL 与七个关键时点快照位于 [live-trial 证据目录](market-egress-R2-evidence-20260926/live-trial/verification.json)。运行 `python3 docs/reports/market-egress-R2-evidence-20260926/live-trial/verify.py` 得到 `status=passed`，逐项复核身份、协议、额度、WAL、终端缺货、容量与退出后的规划。证据不含 token/secret/cookie 字段。原上传前 `main` 字节另留在本机临时封存目录；迁移后的 Memory 与旧二进制不应盲目组合回滚。
