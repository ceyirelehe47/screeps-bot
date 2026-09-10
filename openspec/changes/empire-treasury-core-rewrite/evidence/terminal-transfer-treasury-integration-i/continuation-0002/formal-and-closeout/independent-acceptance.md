# Continuation 0002 · 独立验收记录（第三方判读）

日期：2026-09-10 · 判读方：独立验收 subagent（只读，未修改任何文件；从原始
console/audit/快照重建事实，不采信工具标签与执行 Agent 的总结）

判读对象：`lab-ti1-0002` 正式运行，HEAD `cf29a69`，bundle sha256
`bfbc5c55a9a231ba2d6eb1d4a41aaabf66339ad2779fbf6ad179c70ac9ae6672`。

## 三问结论

1. **恰好一次 `terminal.send()` 边界**：tick 536（=固定 T）。原始 console
   `seq=53` 信封内三条 `lab-send-attempt`：pre-call（fee=26）/boundary/
   sync-return（`{ok:true,code:0}`）；`sync-throw`=0、`lab-treasury-api-error`=0、
   `lab-precondition-rejection`=0。全文件唯一 attemptId `tk1_1_20faab99a8378f8a`、
   唯一 transactionId `455da824072e365`。部署包内 `.send` 仅一处可执行调用
   （无动态访问、无 market/arbiter 源混入），runtime 单飞 + attempted 门控成立。
   完整参数重建：`("H", 100, "W10N57", "lab-ti1-0002 W1N57 to W10N57 100H")`，
   终端 `ti20002aa57000001`（W1N57）。
2. **100H 到账且经国库全链**：536 `admitted`（active phase=pending；committed
   H=100/energy=26；targetRiskAdjustedFree 297900）→ 536 `dispatched`
   （phase=outcome_unknown，dispatch result=unknown）→ 537 世界已变
   （源 900/9974、目标 H=100）且 active 仍 outcome_unknown →
   `lab-treasury-reconcile` `observed_committed/exact_transfer_and_fee` →
   537 `reconciled`（phase=closing、outcome=committed、committed 归零）→
   `lab-treasury-settle` `{status:"ok"}` → 538 起 active=[]（占用解除），
   538–556 全程 healthy。Memory `runtime.treasuryCore.ring` 一条
   closedAtTick=538；counters `admitted=1, dispatched=1, settledCommitted=1,
   unknown=1, rearmings=0`。交易仅 1 条：time=536、H/100、W1N57→W10N57、
   双方同一用户、description 精确匹配、玩家双视图各 1 条且无 `order` 字段。
   物理核对：源 H −100、源 energy −26（=实测费用）、源空位 +126、目标 H +100、
   目标 energy 不变、目标空位 −100、源冷却 546=536+10。
3. **及时停止 + 未决事实保留 + 自动进程确认**：窗口末端先到（34.1s/180s），
   触发延迟 5.86ms（落盘后重打点值；trigger 时刻 2.81ms）、6 次 pause-state
   （556→557 稳定）、stableTick=557、pauseConfirmed=true；撤装写于快照之后
   （actions #21/#22：armed true→false 且 attempted/attemptedTick/syncResult
   完整保留）；进程树 `terminated=true`、7 PID 全观察、polls=1、
   auditErrors=[]、elapsedMs=3245.77（<4500 预算）。

## 独立判定表（22 项，全部 PASS）

窗口完整性（534..556 共 23 样本、无缺无重、experimentId/configTargetTick 全匹配）、
单次边界、无第二入口、同步返回、冻结费用、源/目标库存与空位/容量/冷却、
交易唯一性与字段完整性、admission 占用、观察与结算、占用解除、计数器、
控制槽三态与撤装回读、停止延迟、暂停稳定、进程终止、无错误标记、
模块与源码/清单一致（active main sha256 = 磁盘 bundle = manifest，HEAD=cf29a69）、
无其他用户干扰。

## 独立判读发现的观察点（12 项，均不改变 PASS）

1. `stop-result.killConfirmed=false` 指 stop-controller 内部失败路径未触发，
   **不是**进程未终止；自动终止由外层 `killTree()` 完成，证据在
   process-stop-result（terminated=true）。字段命名易误读。
2. `07-run-treasury.stderr.log` 有一行 `Storage connection lost ECONNRESET`——
   工具在 taskkill 杀掉 storage 进程后自身连接断开，退出码仍为 0；这不是被测
   系统的运行时错误。
3. 537 `before` 的 `targetRiskAdjustedFree=297800` 比世界实际空位低 100：
   未决可能流入的保守占用（kernelUnknownInflowOccupancy），537 reconciled 后
   回 297900；非双花。
4. `paused-snapshot` 仍显示 armed=true——撤装发生在其后；只看快照会误判。
5. 同一次停止有两套 stopRequestedAt/triggerLatencyMs（落盘 I/O 前后重打点），
   stop-result 采用后者。
6. boundary 事件不携带参数——实参由部署包唯一调用点 + 冻结 config + 引擎
   副作用三方向重建。
7. console 证据只能覆盖被插桩的调用点；建议后续把实参/参数哈希随 boundary
   事件输出以闭合该缺口（属证据模型限制，非本次缺陷）。
8. `manifest.json.status="PREPARED_NOT_RUN"` 是构建期标签，实机运行后未更新
   （verify-run 不检查该字段）。
9. `process-stop-result.elapsedMs`（3245.77）与 audit confirmed（3240.37）相差
   一次重测时间，均 <4500。
10. 536 之前存在无样本的 tick 533 周期（观测窗口 T−2 边界），非缺口。
11. 未逐项核对其他 4 名用户 Memory；全局交易集合仅 1 条。
12. `formal-preflight.json` 与 facts sha256 一致、C02 55/55 通过。

## 独立结论

**支持 TREASURY_INTEGRATION_PASS**，并明确四项限制：结论仅针对本组原始证据
（lab-ti1-0002 / cf29a69 / bundle bfbc5c55…），不可外推；证据模型无法数学地
排除未插桩调用；`killConfirmed` 字段语义建议改进；中间态判读需按设计语义
而非数值直觉。
