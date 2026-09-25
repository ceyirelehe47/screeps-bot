# 普通 Terminal 搬运并发 P1：受影响回归与边界

本分支从正式 shard1 当时运行的 `5cef62c5` 建立，与市场 P0 热修和 Treasury T1 候选分开提交。没有修改 Treasury writer、市场价格、Observer/PowerBank，也没有重跑 FC1。

## 原因与修正

`ResourceControl` 的普通 `terminal_feed` 工作可以被多名 carrier 同 tick 选择，但先前只有 `capacity_relief` 标记的 feed 会调用既有 `CarrierAmountSlicePort` 与目标容量 claim。普通生产/市场 Energy 补货缺少这两个数量门槛：例如 1,000 的任务，两名 800 容量的 carrier 可各领取 800。现在所有由 `resourceControl:preload` 发布的 `terminal_feed` 都在 withdraw 前按完整 dispatch ref、task/step 余额和 Terminal 物理容量领取既有 claim；失败、距离不足等路径沿用原释放逻辑，成功 intent 则保留至 tick 结束。

下一 tick 的 `ResourceControl` 补货目标会扣除已经接货、仍指向该 Terminal 的同资源在途量。共享目标容量账本增加只读的资源过滤查询；无资源标识的普通投递仍按总量保守计入。Direct Energy readiness 同步扣除在途 Energy，并把全部在途货物计入 Terminal headroom，避免将「已有货在路上」误报为 `terminal_capacity`。若在途货物已覆盖全部缺口但尚未入 Terminal，观察状态为 `terminal_in_flight`，不会提前声称 terminal 已达到执行储备。

## 验证与限制

受影响的 carrier、数量 slice、目标容量、ResourceControl 容量回归和市场保护/执行测试通过；`npm run typecheck` 通过。构建在提交后重新执行并核对身份。回归实例验证两名 carrier 同 tick 对 1,000 任务只能领 800+200，及下一 tick 800 Energy 在途时原 2,347 补货缺口只再生成 1,547 的任务。

这里使用的是既有 tick 内账本与当前运行实例的 carrier assignment；**global reset 后丢失的在途目的地不能由此证明恢复**。`openspec/changes/decentralized-logistics-contracts` 的持久 StageWorkClaim、单一 executionAuthority 和 reset 恢复仍是独立未完成工作，不能把本 P1 修正当作该整套合同系统已上线。Treasury T1 仍按其自身 OFF / shadow / canary / drain 门槛推进，且不能借此报告推断正式 writer 灰度已经获批或发生。
