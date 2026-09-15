# XII v4 完整 resolved 执行包

此目录由 v4 增量包从固定 XI 归档任务包确定性物化。它包含独立的 XI root lock、v3 superseded post-XII lock 与 v4 corrected post-XII lock，并记录两个精确 source tree。

若本地 compat 仍位于 v3 未推送 source commit，`apply.cjs` 会在完整身份核验后使用包内官方 CAS 迁移替换它；Agent 不得手工 reset、amend、rebase 或改测试。

只按 `AGENT-RUN.md` 执行。不得修改包内文件、锁文件、测试或旧 evidence。
