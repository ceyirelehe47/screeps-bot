# baseline/ —— 基线反例（Evidence Remediation I/§6"先基线、后补修"）

**起点**：7c790712315c0cdde75a262e62b7d728b86a5ed8（隔离 worktree `D:\code\screeps\seal-ev1-baseline`，detach + node_modules junction；工作树=起点 + 未跟踪反例文件，用后即删，不提交）。

| 文件 | 内容 |
| --- | --- |
| commands.txt | 两步命令、退出码与红绿清单总览 |
| sealEv1Baseline.test.ts.txt | 反例源码（非执行归档 .ts.txt；断言"修复后期望的行为"） |
| j06-export.log | 步骤 1：起点实现导出 J06 真实轨迹（exit=0，2 passed/12 skipped，-t 过滤） |
| trace/1788769298193-98236/H18-J06.json | 步骤 1 导出的真实轨迹（V2 反例合法底版输入；起点实现的轨迹形状——修复前提取输出无哨兵） |
| baseline-run.log | 步骤 2：基线反例运行（**exit=1：6 failed / 2 passed / 8 total**） |

## 红灯清单（全部为行为断言失败，零编译错误/缺模块——日志中 `toBeGreaterThan received 0` / `toBe(true) received false`）

| 反例 | 断言 | 起点实现行为（缺口证明） |
| --- | --- | --- |
| V1-delete invocation | 原始记录副本 delete invocation（基线合法 null）经 sealSnapshotUnknownRisk+sealCompareUnknownRisk 必须定位差异 | diffs=[]（undefined→null 抹平）→ 红 |
| V1-delete external | 同型 | 同上 → 红 |
| V1-delete outcomeEvidence | 同型 | 同上 → 红 |
| V2-A 风险证据整项缺失 | 中间检查点 unknownRisk/riskCheckedIds/riskDiff 全 null 必须报风险缺失 | riskCheckedIds=null 被跳过，不比较 unknownRisk → problems 无风险项 → 红 |
| V2-B 实际漂移标签一致 | 中间检查点快照 worstCase 单腿金额+1、riskDiff 仍 null 必须从实际快照重算发现 | 不重算快照、只信标签 → 红 |
| V2-C 中间差异被终态掩盖 | 中间检查点 riskDiff 非空、终态正确不得放行 | 中间 riskDiff 不参与判定 → 红 |
| 对照 1（绿） | 未修改记录集合提取/往返/比较一致 | 通过（红灯非一律报错） |
| 对照 2（绿） | 未修改真实轨迹完整性核验通过 | 通过 |

## 对照修复

同一断言的正式化版本随修复进入 IVKernel（L01/L02/L03 it），修复后 17/17 全绿（final/jest-key.json）；起点红灯与修复绿跑构成同一反例的前后对照。合成记录不据此断言历史真实轨迹已发生风险漂移（§3.1）。
