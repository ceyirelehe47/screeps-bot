# Remediation V 基线反例（fb5e44b 真实复现）

起点 `fb5e44b43cfd14991a721c5ee8fed4a13c5d4d97`（见 baseline-head.txt），干净
worktree（`git worktree add`，node_modules junction 共享），两份重现器经
`--runTestsByPath` 定向运行：

## 文件

| 文件 | 内容 |
| --- | --- |
| r1-baseline-replicator.ts / .command.txt / .run 由 r1-baseline-run.log / .exit-code.txt | R1 基线反例（4 用例：对照 + 3 反例），断言**修复后**语义 |
| v1-baseline-replicator.ts / .command.txt / .run 由 v1-baseline-run.log / .exit-code.txt | V1 基线反例（TRACE + REJECT） |
| r1-baseline-replication.fixed.log | 同一脚本对修复后代码（2ecb43e 起）复跑：**4/4 绿**（exit=0） |
| v1-baseline-replication.fixed.log | 同一脚本对修复后代码复跑：REJECT 绿、**TRACE 红**（错结论路径已被拒绝封闭——预期方向） |

## 基线结果（fb5e44b，均 exit=1）

- R1：对照绿（三候选合法成功）；反例 1 红（回调进入时 `lastEndTick=null`，
  authorize=admitted、dispatch 实际执行、rearm admitted、动作调用 1、发行
  +2）；反例 2 红（全丢写后另一 facade authorize=admitted）；反例 3 红
  （onEffect 抛错后 `lastEndTick=null`、业务放行）。
- V1：TRACE 绿——错结论路径**真实复现**：B0（无 eventBranch）恢复后世界回
  1000、`journal.visibleFor(A)` 仍含 `["adapter-entered","world-effect"]`、
  settle → **committed**（恢复分支世界中效果并不存在）；REJECT 红（不抛错、
  零修改断言无从谈起）。

## 修复后语义的正式回归

R1 反例 1–3 与 V1 REJECT 的断言已作为 I01/I02/I03/I04（VKernel）与 I07
（VService）纳入测试树；上表 fixed 复跑日志是基线脚本本身的对照证据。
