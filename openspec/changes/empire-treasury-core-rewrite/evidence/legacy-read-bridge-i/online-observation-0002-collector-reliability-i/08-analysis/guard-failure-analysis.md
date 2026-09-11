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
| 10:21:42 | restore POST 发起 | `06-online-run/run-restore.jsonl` restore-request-start |
| 10:21:59 | restore 返回 `ONLINE_CLOSE_UNCONFIRMED`（`serverAccepted=true`，回读失败） | `06-online-run/run-restore-result.json` |
| 10:22:00 | collector 以 `guard_finished` 收尾，exitCode=1，单一 footer | `06-online-run/run-collector-result.json` |
| 10:30:40 | **独立只读回读：`CURRENT_IS_BACKUP`**（逐模块匹配） | `07-restore/online-state-verdict-attempt1.json` |
| 10:32:48 | **恢复后主循环确认：19 CPU 帧**（含 58–88 真实 CPU 值） | `07-restore/runtime-confirm-probe.json` |
| 10:33:23 | 第二次独立回读：`CURRENT_IS_BACKUP` | `07-restore/online-state-verdict-3.json` |

## 失败原因

guard 主循环的 `catch{reason='guard_read_or_channel_failure';}` 未保留具体异常，因此**无法从证据文件直接读出根因**；以下是基于证据的推断，并如实标注为推断。

guard 循环内不受内部 try 保护、可抛错的动作只有三类：

1. `C.readJson(upload-attempt.json)` — 该文件在 10:09:26 写入后未再变动，且 guard 在同一路径上成功读取了 12 分钟（`guard-ready.json` 每 500ms 刷新），排除。
2. `C.atomicJson(guard-ready.json)` — 已应用 TOOLING_REMEDIATION 的 retry+fallback，不再因 Windows rename 竞态抛错；且 `guard-ready.json` 的 `updatedAtMs` 停在 10:21:24，与关闭时刻吻合，说明是循环退出而非写盘失败。
3. `await api.time(shard, budget)` — 网络调用，失败即抛 `HTTP_TRANSPORT_ERROR` / `HTTP_DEADLINE`。

**决定性旁证**：同一时段本 Agent 的只读调用两次独立遭遇 `HTTP_TRANSPORT_ERROR`：

- 10:30:40 之前一次（`07-restore/online-state-verdict-attempt1.json` 的首次尝试）
- 10:33:18 一次（第二次回读尝试）

且 guard 关闭前后 collector 的 WS 数据流中断（10:21:26 后无新帧）。因此判定为**外部网络中断**，而非工具逻辑缺陷：guard 正确地 fail-closed 关闭并触发恢复。

## 与任务书的关系

- 任务书 §11 要求 guard 对「heartbeat 过旧」「console 静默」等情形分类关闭。本轮 guard 未退化为笼统 `collector_stalled`（上一轮的缺陷），但**自身的通道异常仍未细分**，落在了兜底 `guard_read_or_channel_failure`。
- 这一兜底虽 fail-closed 正确（未误报成功、未伪造恢复确认），但对「网络中断」与「文件读取失败」不加区分。属本轮新发现的可改进点，**未在本轮修改**——任务书 §4 仅授权修复「补丁在真实环境暴露缺陷」且须严格限定在必要范围，而 guard 行为已满足安全要求（正确关闭 + 触发恢复 + 不伪造确认）。
- 观察窗口 `S=73631900` 从未开始（关闭时 tick≈73631640，距 S 约 260 tick），因此**零采样点**属结构性缺失，不是「只差一条样本」。

## 标签判定依据

任务书 §10：任一采样点缺失 / 正式期间连接关闭 / collector 重启 / runId 改变 / 数据拼接 → 只能标 `ONLINE_COMPAT_READ_INCONCLUSIVE`。
任务书 §10 末条：恢复不确认 → `ONLINE_CLOSE_UNCONFIRMED`。

本轮实际状态：12 个预定采样点**全部缺失**，但恢复已由独立只读回读（逐模块内容匹配）+ 恢复后主循环运行帧双重确认。因此最终标签为 `ONLINE_COMPAT_READ_INCONCLUSIVE / RESTORED`，并同时如实保留 guard 原始产物 `ONLINE_CLOSE_UNCONFIRMED`（不修改、不覆盖该证据，仅以其后取得的独立确认补足恢复结论）。
