# 市场持续出货 R2：r6 复卖核对与有界加速候选

## 当前结论

截至 2026-09-26 12:23 UTC，本轮新代码仅在本地；`shard1/default` 仍运行 r6 `2026.8.29-6+529245b@2026-09-26T08:07:39.599Z`。本轮未上传、未迁移 cfg/permit、未启动加速实例。原 r6 已在上一报告的 tick `73953712` 之后自主完成两次后继成交：tick `73954752` 的 E4N58:X 1,000 与 tick `73955752` 的 E1N57:L 1,000，均写入 V3 `confirmed` receipt。后者之后到本次快照 tick `73957705`，V3 全局滚动已确认量仍为 7,000，未见新增确认。此时旧冷却 `notBefore=73956752` 已过去，最近完整规划有原始买单 19、合格买单 5、最终未选单；只能确认当前没有可执行组合，不能单凭该摘要指认为程序错误或买盘不足的唯一原因。

| attempt | tick | lane | 数量 | 手续费 Energy | 账本经济净价，credits/单位 | 交易 ID |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| 12 | 73953712 | E4N58:X | 1,000 | 777 | 420.505847 | `6ab77d8ea2ce580013d8090a` |
| 13 | 73954752 | E4N58:X | 1,000 | 792 | 428.983512 | `6ab78d42a2ce580013dc044f` |
| 14 | 73955752 | E1N57:L | 1,000 | 799 | 241.503889 | `6ab79c3aa2ce580013dfe453` |

三笔 receipt 所列经济净价合计 1,090,993.248 credits，为含 Energy 影子价格折算的账本值，**不是**游戏账户的实际 credits 入账；账户净变动还混有其他交易，本快照没有逐笔实际 credits 对账数据。上表的 13、14 是自主后继的 V3 receipt 与交易 ID；本轮没有通过另一个完整 outgoing 窗口独立重读这两笔。

## 容量原件

以下是 tick `73957705` 的 ResourceControl Storage+Terminal 实际 used/free，单位为资源数量；容量由两者相加。11:59 UTC tick `73957320` 到 12:23 UTC tick `73957705` 两个端点各房容量均未改变，但有内部搬运、生产和 Energy 消耗，不能把 used 的差额算作市场销量。本段没有新市场确认。

| 房间 | 状态 | used | free | 385 tick used 变化 |
| --- | --- | ---: | ---: | ---: |
| E1N57 | pressure | 917,930 | 382,070 | -102,077 |
| E3N59 | normal | 1,056,164 | 243,836 | +65,356 |
| E4N58 | pressure | 8,010,674 | 289,326 | -7,447 |
| E5N59 | normal | 1,053,918 | 246,082 | +8,088 |
| E6N59 | normal | 1,075,555 | 224,445 | +5,931 |
| E7N57 | normal | 1,060,788 | 239,212 | +132,707 |
| E7N58 | pressure | 889,299 | 410,701 | -129,680 |
| W1N57 | normal | 1,063,087 | 236,913 | -946 |

## 实现边界

候选 r7 只将签名 X/L 最短冷却降到 100 tick；新实例仍受原 V3 唯一 writer、二次读、价格、保护余量、实货、手续费与 CPU 门禁约束。r6→r7 只允许 X/L 旧 revision 的该项变更，迁移保留原 receipt head、finalized sequence、pending 与既有 `notBefore`。V3 基线 WAL/配额继续记 1,000 tick；仅当双份校验的同一个加速实例、现役 permit、原 continuous grant、指定两 lane 和当 tick pressure/emergency 都满足时，prepare 才使用有界 100 tick 放行。旧 V2 与 H canary 不具备此入口。

实例在 Memory.runtime 主/镜像持久记录固定 run ID、原 `notBefore`、permit、attempt 序列、预占 native 次数与数量、固定 `start+3000 tick`/`start+60 分钟` 截止。native 前的预占必须匹配已持久化的 V3 pending 的 tick、attempt、证据哈希、permit、lane 和数量；失败/异常/未知也消耗一次 1,000 的责任，不重复取得额度。至多 10 次/10,000，关闭后不能用同一 run 重启。外部观察者需每 60 秒内续 60 秒控制租约，失联后游戏下一 tick 停止新增加速；时间与额度到期、两房容量恢复正常亦退出。正常市场随之回到原 1,000 tick 基线，未决 WAL 照原策略对账。

## 验证与待执行门槛

以 12:00 UTC 真实 r6 cfg/V3 状态复放：r7 读取旧 permit/账本通过；原 `notBefore` 前没有试运行时 prepare 拒绝；`propose→accept` 后 epoch 16→17，receipt head、finalizedSeq 和 `notBefore` 均不变。测试又从真实账本准备第 15 笔、预占一次、写入 confirmed outcome 并完整推进 WAL；第二笔在 99 tick 被挡、100 tick 可准备，撤掉实例放行则继续受旧 1,000 tick 冷却。主/镜像损坏、同 attempt 重占、10 次额度、固定截止、控制失联和容量恢复均有拒绝/退出回归。该组合模拟交易边界，不能冒充正式服新策略成交。

以 `npx jest --runInBand` 跑市场 V3 automation/ledger/permit/policy、R2 两组、MarketSale 两组及共享 Direct planner/automation，共 10 suite、30 项通过；`npm run typecheck` 通过。独立工作树审查发现 CPU 或试运行预占保护触发后需要立刻关闭加速，已在后继源码提交 `b95b03289a8e352a5302075e23285b8a746267f3` 修复；随后受影响的 2 suite/10 项和类型检查通过。审查确认 diff 没有新增 market deal writer、价格/储备/费用常量没有下降，局部放行只含两条原 continuous lane，旧 receipt/冷却不清空。该干净源码提交的 `dist/main.js` 为 4,558,659 字节，文件 SHA-256 `eadae0149b00fa52feed2e08916193a4115d5c097c0389bf81ade85f7bc5b230`，低于 5 MiB；文档提交之后若重新构建，嵌入的提交身份会使字节哈希改变。观察脚本 `node --check scripts/market-egress-r2-observe.mjs` 与四份 JSON 解析检查通过。

上线前仍需重新读正式服代码与 WAL/cfg/permit/容量/CPU/Memory、完成直接生产授权边界核对；只有这些门槛通过才可进行本次有限发布与观察。`scripts/market-egress-r2-observe.mjs --output <绝对 JSONL 路径>` 只负责已启动实例的单次心跳与读回，不会发起市场交易；心跳结果不明时不重发，控制租约会在 60 秒内失效。正式服无新策略 native 调用、无新策略确认成交、无退出后真实节奏数据。积压长期解除也尚未证明。

## 原始证据

- `market-egress-R2-evidence-20260926/r6-preflight.json`：12:00 UTC 的原 cfg/V3 permit/ledger 与审计头。
- `market-egress-R2-evidence-20260926/r6-market-operator-fixture.json`：真实原状态复放的输入。
- `market-egress-R2-evidence-20260926/r6-monitor-20260926T115938Z.json` 与 `r6-monitor-20260926T122320Z.json`：两个只读巡逻快照，含部署标签、逐房容量和 V3 规划摘要。

上述 JSON 不含凭据字段。生产配置或代码实际变更后应另追加读回与观察原件，不改写这些基线文件。
