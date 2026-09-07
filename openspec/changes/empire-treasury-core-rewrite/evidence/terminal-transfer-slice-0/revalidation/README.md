# revalidation/ — 第二上下文定向复验原始产物（M08）

- 复验身份：**未参与实施的独立 reviewer subagent**，独立干净 worktree（detach `0ce9d971bcf72daf19a1fe68fd7bb384e4db56fe`）+ 独立 `npm ci`（896 包，lockfile 零差异）+ 独立 Jest cache 与输出目录；主工作树全程只读。
- 指令原件：`REVIEWER-INSTRUCTIONS.md`（随产物归档留痕）。
- 时序与逐项结论：`reviewer-log.md`。

## 结果汇总

| 项 | 退出码/数字 |
| --- | --- |
| 任务书 hash（仓库副本 vs Downloads 原文 vs 编制值） | 三方一致 `1d1d8353…5f5` |
| typecheck | 0 |
| production-freeze / config-free | 0×2 |
| M 集合（Slice0） | 1 suite / **8 tests / 8 passed** |
| KEY 六件（`run-key/jest-key.json`） | 6 / **65** / 65 |
| Defense 十一件 | 11 / **118** / 118 |
| 驱动正例（run-key 模板布局） | 0（`TREASURY_EVIDENCE_VERIFY=PASS`；轨迹 problems=0，helper blob `fd930a44…` 自 0ce9d97 加载） |
| 驱动零输入负例 | 1 |
| 驱动缺参数负例 | 2 |
| worktree 前后 status | 均干净；HEAD 未动；用后 `git worktree remove` exit 0 |

## 异常与处置（reviewer 报告原文照录要点）

- **A1 驱动正例首跑 exit 1**：按指令文件字面路径（`--run-dir <OUT>/trace-key`）运行时报"零输入"——reviewer 读驱动源码确认其契约（run-dir 下须有 `trace-key/` 等**子目录**、Jest JSON 在 run-dir 根），任务书 §7.2 模板布局才是正确口径。失败首跑保留为 `verify-evidence-attempt1.*`；按模板重建 `run-key/` 布局并以相同命令重跑 KEY（6/65 与首跑一致）后正例 exit 0；首跑 `trace-key/` 原样保留对照。**该异常是指令文件措辞与驱动契约的偏差，不构成对被验提交的否定**（对应本仓库 evidence/terminal-transfer-slice-0/final 的驱动契约设计）。
- `jest-cache/` 与临时 `empty-dir/` 不随归档（缓存与临时物，非证据）。
