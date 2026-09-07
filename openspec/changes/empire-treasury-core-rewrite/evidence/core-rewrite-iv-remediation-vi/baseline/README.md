# Remediation VI 基线证据（起点 4ba065a5d0a2e7306406ae855c06be756f3136e7）

两个基线反例都在干净 worktree（`git worktree add ../r6-baseline 4ba065a`，
node_modules 经 junction 共享主仓）上真实运行，断言**修复后语义**、以行为
差异变红；变红前的 TRACES 给出缺陷实际形态。重现器源码以 `.ts.txt` 归档
（非执行文本，运行方式见 command.txt）。

## R1：同 tick 成功关窗 + 完整 reset 后 kernel 直接新增业务（J01/J02 基线）

- 源码：`r1-baseline-replicator.ts.txt`（3 用例：主反例 + 未关窗对照 + 下一 tick 对照）
- 运行：`r1-baseline.run.log` / `r1-baseline.jest.json`，exit 1（主反例红；两对照绿）
- TRACES 关键行（缺陷实际形态）：
  - `after-reset={tick:2, heapVetoActive:false, lastEndTick:2, frontier:1, activeCount:1}`——模块重建后 heap 否决丢失、持久关窗仍在
  - `post-reset-admit={status:"admitted", frontierDelta:1, activeDelta:1}`——**缺陷：持久关窗下直接 kernel admit 错误接纳**
  - `post-reset-dispatch={status:"not_executed", adapterCalls:1}`——错误签发的新许可执行并**进入 adapter**
  - `post-reset-execute-rearm={status:"admitted"}`——rearm 通道同样漏（activeDelta 0：child 替换父代语义）
  - 红灯断言：`expect(newAdmission.status).toBe("rejected")` received `"admitted"`（treasuryR6R1BaselineReplicator.test.ts:150）
- 治愈复验：`baseline-healed-on-fix.log`（修复 335b06d 后主仓运行）——R1 三用例全绿，同一 TRACES 位置变为 `post-reset-admit={status:"rejected", reasonCode:"lifecycle_closed", frontierDelta:0, activeDelta:0}`、`post-reset-execute-rearm={status:"rejected", …, parentPhaseAfter:"retry_ready"}`
- 本反例不以"旧许可失效"代替：主反例证明的是**新 runtime 新签发**路径；resetModules 后旧许可被真实性校验拒绝属另一事实（J01 主用例中单独分类）

## V1：旧 H18 fixture 的健康红灯与零推进空转（J05 基线）

- 源码：`h18-health-baseline-replicator.ts.txt`（旧 H18 fixture 原样复制 + 健康断言 + 12 tick 零推进轨迹）
- 运行：`h18-health-baseline.run.log` / `h18-health-baseline.jest.json`，exit 1
- 关键输出：
  - `health={"status":"unhealthy","reason":"active[tk1_h18_00] 阶段 closing 但结果未确定或无证据（结构矛盾）"}`——生产 validator 正确拒绝（closing 有 outcome 但 outcomeEvidence=null；retry_ready/pending 的 outcome=null 同样非法）
  - `per-tick-releases=[0,0,0,0,0,0,0,0,0,0,0,0]`、`total-release-calls=0`、`phases-after-12-ticks={closing:30, outcome_unknown:20, retry_ready:10, pending:4}`——unhealthy 下生命周期静默早退、12 tick 零推进
  - 旧 H18 断言（释放 ≤4、unknown 计数=20、失败义务在）在零推进下全部空转成立——测试前提无效的完整证据
- **修复后该重现器保持红是预期**：V1 的修复是换用合法 fixture（新 H18/J05）+ 真实推进断言（J06），**不是放宽 validator 让旧 fixture 变 healthy**。治愈口径见 `baseline-healed-on-fix.log`（R1 全绿、V1 仍红——与"不许放宽 validator"一致）
