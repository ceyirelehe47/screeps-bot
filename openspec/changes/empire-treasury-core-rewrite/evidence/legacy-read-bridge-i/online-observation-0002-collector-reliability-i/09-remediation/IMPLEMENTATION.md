# Online Observation 0002 — Evidence & Guard Remediation I

本目录由已完成的实现包按固定字节写入，执行 Agent 只负责应用与验证，不负责设计或补写实现。

## 证据整改

- 原始提交 `d6445029e445a09237752cba205baa6b647a7ce0` 将三份完整线上模块快照误提交进 Git。
- 本整改只从当前树线性删除这些文件；禁止 amend、reset、rebase 或 force-push，因此相关 Git blob 仍保留在已推送历史中。
- 历史 blob 的秘密扫描必须使用本地真实凭据执行，但报告只能保存命中类别、文件/blob 标识与计数，不能保存 token、token 前缀或匹配正文。
- 上一轮 24 项 Agent 独立测试只提交了 TAP/exit，没有提交实际源码。该事实无法从 Git 逆向修复，本整改不会根据 TAP 重建或冒充原源码。

## 新实现的验证源码

`guard-verification-tests/` 是本轮新 Guard 控制面实现的完整测试源码，身份与上一轮 24 项测试独立。它验证：

- HTTP/tick 读取的有限重试、degraded 状态和连续失败 fail-closed；
- artifact 读取的有限重试与分阶段错误分类；
- 脱敏诊断不保存原 message/stack，且 UTF-8 字节上限真实有效；
- collector PID 不变与 CPU 通道持续新鲜；
- 联合探针不包含 Screeps code 写接口；
- Guard 终态在 lock 清理之后写出；
- Windows `atomicJson` 修复的基础替换行为。

这些测试不能回填上一轮 24/24 的可复现性，只能作为本轮实现的独立验证证据。

## 允许的阶段结论

本轮未授权正式候选上传。通过后只能使用：

```text
EVIDENCE_REMEDIATED
GUARD_CONTROL_PLANE_IMPLEMENTATION_VERIFIED
GUARD_COLLECTOR_CONTROL_PLANE_PROBE_VERIFIED
NOT_DEPLOYED
```

不能使用 `ONLINE_COMPAT_READ_OBSERVED` 或 `TREASURY_PRODUCTION_READY`。
