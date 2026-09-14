# Source Manifest Remediation + Subphase Online X · v2

这是修正版合并闭环任务包。它同时修复上一包在 remediation 阶段暴露的两个确定性缺陷，并继续完成同一轮的离线门禁、四点线上归因、恢复和证据推送。Agent 不需要继续实现代码。

修复内容：

1. 不再用经过 `.trim()` 的文本解析 `git status --porcelain`；remediation 使用 NUL 分隔的原始字节解析。
2. 将重生成后的 `docs/treasury-compat-loader-optimization.json` 纳入 payload、LOCK、source lock 和提交范围。
3. 支持两种精确起点：远端根基线上的干净本地根，或 Agent 已创建但未推送的精确四路径 partial remediation 提交。后者不 reset、不改写历史，而是追加一个仅补 provenance 的 completion 提交。

之后继续执行：完整离线门禁 → 四点真实引擎子阶段归因 → 旧生产恢复与 75 秒运行确认 → 归档和普通推送。

固定远端起点仍为：

```text
compat   57987cda22553fcdc842e8d4c72a98b6e94e00fb
refactor 73726cd44267b0f583f5d08890233ad67a5e803a
```

本轮预算仍为 2，房间仍为 E3N59/E4N58，资源仍为 energy/H，不追加第五点，也不把 `partial_cpu_budget` 冒充完整样本。
