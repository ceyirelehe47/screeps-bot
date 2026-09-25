# 市场出货 P0：线上成交、底价与空位趋势

## 现役身份与账本

本报告在 2026-09-25 UTC 晚间只读核对 shard1。正式代码由原现役 `5cef62c5` 起修，市场分支 `codex/market-egress-p0` 单独提交；Treasury、Observer/PowerBank 未混入。`origin` 是 `https://github.com/ceyirelehe47/screeps-bot.git`。最近部署标签为 `2026.8.29-6+58cdfeb@2026-09-25T22:28:22.045Z`，上传脚本将远端 `main` 模块与本地产物逐字节哈希核对成功。市场请求与生效均为 Direct，V3 cfg 为 r5，permit epoch 11，E4N58:X 为 `continuous/enabled`，E1N57:L 为 `canary/enabled`。只有既有 V3 writer 可执行卖单。

V3 原账本 receipt head `csh1:ef05b85f11756794f39f1d6135b5e8c2`；`pending` 缺席、hard blocker 缺席、未重置 reservation、保护或高水位。滚动全局额度 12,000 / 30,000 tick，当前确认 1,000、余 11,000；房间 5,000、lane 3,000、X 资源 8,000，单笔 1,000，确认后全局冷却 1,000 tick。下一次可执行 tick 为 `73944717`。这些是**有效上限**，不是立即可卖承诺；还须重新读取真实订单、终端实货、手续费 Energy、净价和保护余量。

## 真实成交与故障归类

E1N57:X 在 tick `73943262` 曾写入 attempt 7，但下一 tick 完整交易窗口与终端/credits 状态均未变化，正式对账为 `not_filled`，实际量 0；没有自动重发。随后修复激活锚误判并在主/镜像状态一致时恢复。E4N58:X 的 attempt 8 在 tick `73943717` 成交 **1,000 X**，订单 `6ab01e659ddb7f001301c12c`、真实交易 ID `6ab6eb4ca2ce580013af3b95`，成交价 448.104、手续费 Energy 792、净额 420,313.512 credits（单位净价 420.313512）。下一 tick receipt 确认为 `confirmed`，累计历史确认变为 7 笔 / 7,000 X。该交易也通过 `Game.market.outgoingTransactions` 独立核对。

原 X 硬底价 480 令约 443.666 的真实买单进不了候选。r5 将 X 硬/经济下界重标为 371/390，并按可信交易日、实时**可执行**买单和保护后库存计算动态净价地板；当前 X 执行底价 390，L 为 237.07。最近 X 买单 `452.586 × 7,760`，同房间计划净价约 424.80，超过 X 底价。L 有 `285.368 × 4,147` 等买单，也超过当前 L 动态地板所需区间；当前阻止第二笔的是账本冷却。O 的最高有效买价约 22.73，低于 O 的经济下界 74，归类为**没有合适买单**，不靠进一步降底价制造交易。E6N59:X 总量约 71k，低于不变的 100k 保护储备，归类为**没有可售余量**。先前 planning CPU 耗尽、WAL receipt_written 闩锁与错误容量/备货约束属于**程序故障**，已分别修复、验证和读回。

E1N57:L 在 tick `73944352` 经原 `proposeMarketBaseResourcePermit → acceptMarketBaseResourcePermit` 签为 canary，未触碰 E4N58:X 连续授权。它已有终端 L 实货和手续费 Energy，将在全局冷却后由原 writer 逐 tick 重新决策；当前价格优先排序仍可能先选 X。新增授权不等于已成交，不能用 permit 或日志数代替验收。

## 八房容量与净流入

同口径 `ResourceControl` 样本：

| UTC / tick | 八房 storage+terminal 空位 | 八房 storage+terminal Energy | emergency 房间 |
| --- | ---: | ---: | ---: |
| 22:14 / 73944190 | 502,342 | 5,847,302 | 4 |
| 22:18 / 73944265 | 510,790 | 5,837,854 | 4 |
| 22:25 / 73944375 | 532,705 | 5,816,254 | 4 |
| 22:28 / 73944425 | 546,115 | 5,802,844 | 4 |

这 235 tick 内空位增加 43,773、Energy 减少 44,458，期间没有新的市场成交。之前约 19:18 UTC 的八房空位为 376,437、Energy 为 6,012,110；到 22:28 分别改善 169,678 和减少 209,266。空位改善主要与暂停过剩 Energy 净流入、常规消耗/内部调度有关，**不能把它全归给 1,000 X 市场成交**。E4N58 单房从此前 storage/terminal 均无空位到本次 storage 空位 15,164、terminal 空位 24,334；E1N57、E5N59、E6N59、E7N57 的 terminal 仍满，全房爆仓问题尚未解除。

现役 E4N58 storage X 约 2,942,223、K 1,107,579、L 890,366、Z 641,171，terminal X 约 2,880。E1N57 的 X 与 L 分别约 275k、167k 在 storage，terminal 另有约 66k X 和 27k L。相反，E6N59 X 约 71k，不能卖穿保护储备。E4N58 原生 X 矿工在部署后 `actionLog.harvest=null`，矿点两次读取均为 57,424；大于「100k 保护储备 + 100k 生产缓冲」时暂停采掘、停止新矿物搬入与替补矿工配置。读回 E1N57/E4N58 的原矿 config `roomName` 均已撤销，队列清理回归通过；现存矿工自然到期。低于缓冲阈值时自动恢复采掘，不侵蚀关键生产和防御储备。

## 代码验证与未结验收

动态底价、Direct 候选、原 carrier board 货物/手续费 Energy 准备、执行前双读、WAL 对账和空位恢复都在原链路修复。出货不受普通**入库** headroom 错误限制；terminal/storage 物理容量、保护 ledger、手续费上限和未知结果对账仍有效。近期新增的矿物净流入门禁和过剩原矿替补取消，受影响的 role、bootstrap、workforce、spawn、mineral extraction 套件共 28 项通过；`npm run typecheck` 与提交后 `npm run build` 通过。

P0 仍需下一笔及后续多个窗口的真实 outgoing transaction、WAL 完整确认与持续空位/净 Energy 趋势；不能以首笔 1,000 X 或此刻的短期空位回升结案。当前设计 1,000 tick 冷却及 12,000 / 30,000 tick 上限限制吞吐，若后续净流入仍高于它，必须走原 permit/ledger 的版本化额度变更，不能清空 pending、高水位、预约或另建卖货 writer。Treasury T1 与普通 carrier 并发修复保留 P1 独立分支，FC1 不重跑。
