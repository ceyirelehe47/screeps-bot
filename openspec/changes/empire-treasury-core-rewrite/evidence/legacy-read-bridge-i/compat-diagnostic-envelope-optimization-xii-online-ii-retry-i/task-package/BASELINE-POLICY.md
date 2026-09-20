# Live Baseline Policy

## 已授权基线

唯一可授权本轮在线写入的线上基线，是 XI 恢复闭环已经验证过的旧生产字节：

- modules digest: `84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf`
- main: `4,494,463 bytes`
- main SHA-256: `37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b`
- build commit: `06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c`
- build tree: `929fa9557b1a36135a5ef1605231be1d16e87366`

## 未授权状态

Agent 在 v4 后报告的 `4,494,466 bytes / eaa54506…` 没有进入 GitHub evidence，来源未知。即便它稳定、仍嵌入旧 build identity，也不能自动视为旧生产或安全状态。

## 执行规则

1. 所有网络等待发生在窗口绑定和写入之前。
2. 需要三次连续稳定读取。
3. 稳定读取仍与已授权基线不一致时，终态为 `LIVE_BASELINE_DRIFT_UNRESOLVED`。
4. 未知漂移不会触发 config commit、candidate build upload 或 restore POST。
5. 若存在固定 XI `backup.json`，只生成有限 hex 差异窗口；原始模块不进入 evidence。
6. 不提供接受任意 current-live bytes 的开关。
