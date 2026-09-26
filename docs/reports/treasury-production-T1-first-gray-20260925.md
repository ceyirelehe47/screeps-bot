# Treasury Production T1：首次正式灰度说明（准备稿，2026-09-25）

## 候选与首个切片

源码为 `69bf15cf2a533a8adc3f642f7de16bc529915d53`；冻结 `main` 的 SHA-256 为 `368196906dbd95dffe69bd830c2274988425fcef09d32a817eb0bfcdb6bb576c`，大小 4,946,214 字节。候选默认 OFF，从旧生产源码移植必要 Treasury 能力并包含现役巡逻修复。它只接管本账号 `E3N59 → E4N58` 的**一条已存在且合法**的 H 转运任务，至多 100 H、实际费用至多 100 energy、一次持久配额只允许一次 native dispatch；不会为灰度自动造任务。

## 写入与权威路径

| 位置 | 作用 |
| --- | --- |
| `src/main.ts` | 每 tick 在旧业务阶段前启动 Treasury 生命周期，尾部做 shadow/收尾。 |
| `src/runtime/resourceControl.ts` | 在旧任务排序和共享 send budget、terminal busy、接收容量账本内交出匹配切片；新路径接管、拒绝或未知时，本 tick 不回退旧发送。 |
| `src/runtime/resourceReservation.ts` | 非空旧预约经版本化迁移为 typed owner；坏数据或未知版本保留原表并拒绝新接管。 |
| `src/runtime/marketActionArbiter.ts` | T1 配额、租约或执行记录未闭合时，围住两端 terminal 及发往目标房的竞争写入。 |
| `src/runtime/treasuryTerminalTransfer.ts` | 以真实结构、Store、费用和共享容量复验；配额与租约落盘、原生发送、交易对账、确认后扣旧任务余量，drain 后交回旧模式。 |

旧任务和旧预约仍是业务权威；内核 work 记录的是执行责任。同一切片在承诺计算时按精确 task ID/数量排除，其他旧责任继续计入。隔离引擎实际发送及排他行为的原始证据见 [验收报告](treasury-production-T1-engine-acceptance-20260925.md)；未知结果和冲突故障由定向确定性测试覆盖。

## 正式执行前的只读核对

1. 先完成独立代码审查及已归档的 G1/FC1 成本结果评审，并为**本候选正式上传与一次 writer 灰度**取得单独决定。本候选尚未上传；G1 曾临时上传只读兼容候选，随后精确恢复到巡逻修复原版。G1 的候选/恢复身份已按当前巡逻基线重建并验证，不能将那次恢复流程沿用到本候选的 writer 灰度。
2. 按 `screeps-game-data` 的只读 `npm run monitor:once`、必要时指定 shard1 的 Game/Memory 读取路径，记录时间、tick、`lastDeployTag`、活动 branch 与完整 `main` 字节指纹。另读两房所有权、terminal ID/冷却、H/energy/总容量、真实 `calcTransactionCost`、现有旧任务和非空预约。若无匹配任务，保持 OFF；不临时制造生产需求。
3. 对比正式服已有任务/预约 schema 与候选迁移规则，验证目标共享容量和其他业务责任；确认源码及构建字节仍与上述 SHA 相符，且没有夹带 G1 或其他 writer 变更。按正式服实际 CPU/bucket 与本报告隔离引擎数据定灰度窗口。

## 切换与停止

| 步骤 | 预期与观察 |
| --- | --- |
| OFF 上传后 | 连续观察旧任务、预约、交易与 CPU；不得出现 Treasury 内核、隐式迁移或新发送。 |
| shadow | 只读报告能够观察两个房间和 H/energy；业务任务与交易不变。 |
| canary | 只对预先确认的任务启用一次切片。原生交易最多一笔、H 不超过 100、原生手续费不超过 100 energy；交易确认前旧任务 remaining 不减少。记录源/目标 Store、任务租约、配额、内核状态和 CPU。 |
| drain | 停止新接纳，保留执行/对账责任；若结果未知，继续阻止旧 writer 接手该 work，不重复发送。 |
| OFF 交回 | 只在 active 清空、配额 drained、任务租约已释放且交易与库存对账一致后，由**当前候选版本**的旧路径继续未发送的任务余量。 |

**本轮拟采用的人工停止阈值是策略选择，不是隔离引擎实测结论**：切 canary 前 bucket ≥ 8,000、前 20 tick 的空余 CPU 每 tick ≥ 50；运行中 bucket < 5,000、出现未知结果/迁移失败/重复交易/任务进度与交易不符、或目标容量冲突，即转 drain 并保存原始状态。任何一项不能读到时不启用 writer。实际 shard1 CPU 门槛须在正式只读预检中用真实 tickLimit 与业务负载核定；隔离引擎发送 tick 的 38.796 CPU 不能直接当作 shard1 预算。

停止时先在候选版本转 `drain` 并确认收尾，再置 OFF。候选内的 OFF 交回已经在真实隔离引擎证明。**不要在 active/unknown 未结或仅凭 OFF 开关就覆盖旧二进制**；旧二进制对 typed owner v4 预约表的兼容性还需单独验证，恢复历史整份 Memory 也会覆盖新的世界进展。若无法证明安全交回，则保持受影响终端 fenced、保留当前候选与证据并人工排查。

## 当前结论

本文件是可审查的首次灰度操作边界，不是已获正式部署授权或线上成功记录。G2 在隔离引擎的成功链路与 CPU 观察已完成，G1 四点实测与精确恢复也已完成；正式 shard1 writer 灰度及独立审查仍待执行。当前证据身份与限制见 [最终状态](treasury-production-T1-final-status-20260925.md)。
