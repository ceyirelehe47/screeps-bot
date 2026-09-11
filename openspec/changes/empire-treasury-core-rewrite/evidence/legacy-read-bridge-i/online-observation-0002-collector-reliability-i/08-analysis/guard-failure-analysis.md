# 正式观察轮失败分析（guard_read_or_channel_failure）

## 结论

本轮在观察窗口开始前被 guard 主动关闭，**bridge 样本为 0**。恢复已完成并独立确认。

## 时间线（全部为证据文件内的实测时刻，UTC）

| 时刻 | 事件 | 证据 |
|---|---|---|
| 10:08:47 | 前检通过，线上=生产基线 `06ffedb`，tick=73631466 | `05-profile-and-build/preflight-final/` |
| 10:08:56 | guard 启动 | `06-online-run/run-guard.jsonl` guard-start |
| 10:09:1x | collector streaming，两频道新鲜 | `06-online-run/run-heartbeat.json` |
| 10:09:26 | 唯一一次上传成功 `UPLOADED_AND_READBACK_VERIFIED` | `06-online-run/upload-execute.json`、`run-upload-attempt.json` |
| 10:09:29 | guard-ready（state=ready, collector=streaming, socket=open） | `06-online-run/run-guard-ready.json` |
| 10:09:59 – 10:21:29 | 监控持续记录 collector=streaming、guard=ready、console 帧新鲜（最后一条 consoleAge=3061ms） | `06-online-run/window-monitor.jsonl` |
| **10:21:32** | **guard 触发关闭，reason=`guard_read_or_channel_failure`** | `06-online-run/run-guard.jsonl` close-trigger |
| 10:21:35 – 10:21:56 | collector 在 guard 触发后仍持续收到 console/CPU 帧；10:21:48 还收到恢复后的旧生产 deploy 帧 | `06-online-run/run-console.jsonl` |
| 10:21:42 | restore POST 发起 | `06-online-run/run-restore.jsonl` restore-request-start |
| 10:21:59 | restore 返回 `ONLINE_CLOSE_UNCONFIRMED`（`serverAccepted=true`，回读失败） | `06-online-run/run-restore-result.json` |
| 10:22:00 | collector 以 `guard_finished` 收尾，exitCode=1，单一 footer | `06-online-run/run-collector-result.json` |
| 10:30:40 | **独立只读回读：`CURRENT_IS_BACKUP`**（逐模块匹配） | `07-restore/online-state-verdict-attempt1.json` |
| 10:32:48 | **恢复后主循环确认：19 CPU 帧**（含 58–88 真实 CPU 值） | `07-restore/runtime-confirm-probe.json` |
| 10:33:23 | 第二次独立回读：`CURRENT_IS_BACKUP` | `07-restore/online-state-verdict-3.json` |

## 失败原因

guard 主循环的 `catch{reason='guard_read_or_channel_failure';}` 未保存异常对象、稳定错误码或当前失败阶段，因此**无法从证据文件直接读出根因**。统一 catch 覆盖的控制通路至少包括：

1. `C.readJson(upload-attempt.json)`；
2. `C.atomicJson(guard-ready.json)`；
3. `await api.time(shard, budget)`；
4. 上述语句附近的其他未预期本地异常。

attempt 文件在此前长期稳定、`atomicJson` 已做 Windows 竞态修复，这些事实只能降低相应可能性，不能从统一 catch 中排除它们。稍后的只读调用两次遭遇 `HTTP_TRANSPORT_ERROR`：

- 10:30:40 之前一次（`07-restore/online-state-verdict-attempt1.json` 的首次尝试）；
- 10:33:18 一次（第二次回读尝试）。

它们使 `api.time()`/HTTP 控制通路成为**合理但未证实的假设**。不能把这些稍后发生的错误当成 10:21:32 异常的直接证据。

反证同样明确：collector 在 guard 触发关闭后仍持续收到 WebSocket 帧，最后有效帧延续到 10:21:56，并在 10:22:00 写出 footer。因此原报告所称“10:21:26 后无新帧”及“collector WS 中断”不成立。

可支持的最终表述只有：**guard 控制通路发生未分类异常；具体来源未知。** guard 的 fail-closed 与恢复触发是安全的，但诊断和瞬时失败处理需要单独整改。

## 与任务书的关系

- 任务书 §11 要求 guard 对「heartbeat 过旧」「console 静默」等情形分类关闭。本轮 guard 未退化为笼统 `collector_stalled`（上一轮的缺陷），但**自身的通道异常仍未细分**，落在了兜底 `guard_read_or_channel_failure`。
- 这一兜底虽 fail-closed 正确（未误报成功、未伪造恢复确认），但没有区分 HTTP/tick、不可变证据读取、心跳/ready 写入或内部异常，也没有为单次瞬时 HTTP 失败提供有限重试。再次正式上传前，必须保存脱敏后的失败阶段与稳定错误码，并通过 guard+collector 联合无上传探针。
- 观察窗口 `S=73631900` 从未开始（关闭时 tick≈73631640，距 S 约 260 tick），因此**零采样点**属结构性缺失，不是「只差一条样本」。

## 标签判定依据

任务书 §10：任一采样点缺失 / 正式期间连接关闭 / collector 重启 / runId 改变 / 数据拼接 → 只能标 `ONLINE_COMPAT_READ_INCONCLUSIVE`。
任务书 §10 末条：恢复不确认 → `ONLINE_CLOSE_UNCONFIRMED`。

本轮实际状态：12 个预定采样点**全部缺失**，但恢复已由独立只读回读（逐模块内容匹配）+ 恢复后主循环运行帧双重确认。因此最终标签为 `ONLINE_COMPAT_READ_INCONCLUSIVE / RESTORED`，并同时如实保留 guard 原始产物 `ONLINE_CLOSE_UNCONFIRMED`（不修改、不覆盖该证据，仅以其后取得的独立确认补足恢复结论）。
