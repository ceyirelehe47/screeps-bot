# D24 负向变体三件套——红灯验证记录（Core Rewrite IV）

日期：2026-09-06。基线代码：本分支 IV 修复后源码（变体临时代码由
`.tmp-variant-cycle.py`（轮次内临时脚本，验证后删除）应用/还原，每轮
应用 → 运行 → 还原，工作树最终与验证前一致）。

每个变体对应一个 D 断言的**语义**失败（不是编译错误或收集失败）；
还原后对应测试全部恢复通过（见 restore-verification.log）。

## 变体 A——取消 committed 退出的观察覆盖门禁

- 补丁：`kernel/commands.ts` `observationTakesOverEffect` 在锚点判空后
  直接 `return true`（无条件判覆盖——时间序与范围检查全部旁路）。
- 命令：`npx jest --config jest.config.cjs --runInBand src/runtime/treasury/treasuryRewrite4Acceptance.test.ts -t "D01" --verbose`
- 结果：exit 1，**2 failed / 18 skipped**（variant-A-run.log）：
  - "目标位置不在适用观察范围……不退出" 失败——观察范围缺失时聚合被
    删除（`stillActive` 断言失败）；
  - "范围恢复后正常退出" 失败——第一段"隐藏范围仍保留"的中间断言
    失败（已被提前删除）。
- 对应实现：IV/R1 退出条件（commands.ts observationTakesOverEffect +
  kernel.ts observeForCleanup 端口）。

## 变体 B——恢复 fresh 耗尽的旧快照回退

- 补丁：`facade.ts` `evaluateRevalidation` 将 fresh null 的
  `observation_unavailable` 阻断替换回 `fresh ?? ensureTickState(true).observation`
  （旧快照回退——结构 incarnation 检查重新基于过期快照）。
- 命令：`npx jest --config jest.config.cjs --runInBand src/runtime/treasury/treasuryRewrite4Acceptance.test.ts -t "D04" --verbose`
- 结果：exit 1，**1 failed / 19 skipped**（variant-B-run.log）：
  - "额度耗尽后结构换 ID：blocked、实际调用 0" 失败——执行以旧快照
    通过（`status === "blocked"` 断言失败，实际为 committed、调用 1 次）。
- 对应实现：IV/R2（facade.ts evaluateRevalidation）。

## 变体 C——恢复"确认命令额外 +1 份"预算

- 补丁：`kernel.ts` `applyPrepaidCleanupCommand` 的 budgetUsed 记账从
  `effectiveUsed`（使用已预扣份额）改回 `effectiveUsed + 1`。
- 命令：`npx jest --config jest.config.cjs --runInBand src/runtime/treasury/treasuryRewrite4Lifecycle.test.ts -t "D13" --verbose`
- 结果：exit 1，**1 failed / 11 skipped**（variant-C-run.log）：
  - "每 tick 端口 >0 且 ≤8、remaining 单调减少、至多 3 个完整预算 tick
    结束" 失败——确认命令再次要求第 9 份份额（validator 拒绝回滚），
    remaining 无法持久清零（R4 死锁复现）。
- 对应实现：IV/R4 成对预算（kernel.ts prepayReleaseUnitBudget +
  applyPrepaidCleanupCommand）。

## 还原后验证

命令：`npx jest --config jest.config.cjs --runInBand src/runtime/treasury/ --verbose`
结果：20 suites / 425 tests 全部通过（restore-verification.log）。
