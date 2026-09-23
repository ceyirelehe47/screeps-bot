# Treasury Read Path R1 v2 — 修复历史断言并接续

本包仅接续 R1 v1 在 `full-offline-gates / COMMAND_FAILED:build` 的 465/467 STOP。
R1 性能实现、全部 43 项 Core 回归、2 CPU 预算及实验额度不变。

阅读本目录 `AGENT-RUN.md`，使用 `tools/run.cjs --prior-work ...`。
不要重新执行 references 中的旧任务书；不要从 XV 起点重做 R1；不要 reset、amend、清理旧日志或授权 marker。

原本地 R1 提交必须保留；修复工具验证原 9 路径完整来源后，只追加修改两个历史测试的提交。
完整 467 项仓库门禁及 165 项继承工具测试全部重新执行，全部通过才发布默认 OFF 源码和启动原有唯一四点实验。

制作端 133 项包测试不是完整仓库门禁。实际覆盖及未运行项见 `MAKER-VALIDATION.json`。
