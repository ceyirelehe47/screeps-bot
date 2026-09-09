# Screeps Control Remediation I — implementation package

状态：**已实现并完成选定文件的离线检查，等待 Agent 独立全环境验收。**

基线：`ceyirelehe47/screeps-bot` / `refactor/empire-treasury-rearchitecture` /
`d69726a92d46c3ab334355a6625ef253c1523a86`。

先阅读 `AGENT-VERIFY.md`。本包包含：

| 文件 | 用途 |
|---|---|
| `changes.patch` | 唯一既有实现修改 + 实验工具/测试新增，共 17 个文件 |
| `modified-files/` | 补丁目标内容，供阅读与 hash 对照，不覆盖整个仓库 |
| `source-manifest.json` | 固定起点、原源码 Git blob、补丁 SHA-256、各目标文件 hash |
| `apply_patch.py` | 检查准确基线/干净工作树/文件字节，再 git apply；不 commit、不 push |
| `validation/` | 83 个 Node 测试、实际 CLI 退出码、有限类型检查、补丁重放的原始结果 |
| `reference-task.md` | 已有 Control Remediation I 任务的原件，仅作为验收边界参考 |

修改只位于 `test/lab/terminal-transfer/`。不包含生产 Treasury/Defense 修改，不修改旧证据、原 main/single-shot/observer 或发送保护，不带真实凭证，不自动启动或连接游戏。真实 API 与 Windows 进程清理仍需独立测试。

`apply_patch.py` 有意要求文件字节与固定基线一致。Windows 若因自动 CRLF 转换而拒绝，不要强行绕过校验或覆写现有改动；在单独的、LF checkout 的干净工作树中验证补丁。包内 `.d.ts` 仅放在 `validation/` 作为有限类型检查的证据，绝不复制进项目类型声明。

83 是 Node 测试用例数；新增 Jest wrapper 为 1 个 suite / 3 个 tests，全仓数量以 Agent 实际收集为准。工具控制流程通过不等于真实转运通过。
