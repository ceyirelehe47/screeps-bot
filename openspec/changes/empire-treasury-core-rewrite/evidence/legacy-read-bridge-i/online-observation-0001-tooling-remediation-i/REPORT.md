# Online Observation 0001 · Tooling Remediation I — 执行记录与独立判读

日期：2026-09-11。执行环境：Windows 10 (win32 10.0.26200)、Node v22.19.0、Git Bash。
任务包：`screeps-treasury-compat-online-tooling-remediation-I-task-package-2026-09-11.zip`（sha256 `778a3075951b970a…`，原始 zip 保留于本地 incoming/ 与服务器，未回写）。

## 终态

**`ONLINE_COMPAT_READ_INCONCLUSIVE / RESTORED`**

上传成功且逐字节回读验证，但首个采样点（S=73624800）到达前 collector 的 WebSocket 流停滞，guard 按设计以 `collector_stalled` 触发关闭并精确恢复原件。零桥样本，观察材料不足；恢复经恢复子进程回读 + 本会话独立回读 + 60 秒 cpu 帧监听三重确认。失败不换窗口重试，未第二次启用。

## 时间线（UTC）

| 时刻 | 事件 |
|---|---|
| 01:50:34 | preflight-initial：线上=原件（4,494,463B，sha256 `37d20706…`，集合摘要 `84f76975…`，BUILD_COMMIT `06ffedb`），tick 73624113 |
| 01:53:19 | PROFILE_HEAD `63c6f11` 构建完成（bundle 4,586,847B，内嵌 hash `e625a71b…`） |
| 01:55:39 | preflight-final：线上仍=原件，tick 73624192 |
| 02:00:26 | SESSION_PREPARED：runId `ca35ed4a…`，候选集合摘要 `cedf39e3…` |
| 02:02:33 | collector(PID 12792) 与 deadline-guard --execute(PID 28444) 启动；collector streaming、收到 console/cpu 帧，guard ready |
| 02:03:29 | upload-once 预演 `DRY_RUN_WOULD_UPLOAD`（upload.jsonl） |
| ~02:03:59 | upload-once --execute 的唯一 POST 发出并被服务器接受 |
| 02:03:59.7 | collector 收到 console 帧 `[deploy] 2026.8.29-6+63c6f11@2026-09-11T01:53:19.664Z`：候选在线运行确认（帧先于本地验证完成属正常顺序） |
| 02:04:04 | upload-once 输出 `UPLOADED_AND_READBACK_VERIFIED`（回读+活动分支复查完成，唯一 attempt，1 次 POST） |
| 02:16:25 | 最后有效 console 帧（heartbeat lastConsoleAtMs）；02:16:29 为 console.jsonl 物理尾帧（空 log 帧）与心跳最后更新，进程随后 exit 1，无 collector-footer |
| 02:16:39 | guard `close-trigger: collector_stalled`（心跳 10s 过期阈值） |
| 02:16:55 | 恢复子进程完成（15.8s）：`RESTORED_AND_VERIFIED` → guard 终态 `ONLINE_BYTES_RESTORED`，collector 见终态后退出 |
| 02:19-02:26 | 独立确认：game/time 推进（73624580）；user/code 回读=原件（摘要/字节数/BUILD_COMMIT 全匹配） |
| 02:29 | 60 秒只读 cpu 频道监听：16 个 cpu 帧（每 tick 一帧，样本值 0/62/81）+15 个 console 帧：旧主循环恢复运行 |
| 02:33 | 候选分支 CLOSED_SOURCE_HEAD `9153274`：profile 恢复已验收默认 OFF（configSha256 `ff29168…` 与 6a63a2a 一致）；此关闭构建不上传 |

## 工具修复（两处，均按 AGENT-RUN.md §4/§5.2 授权，单独 diff + 全量回归 + TOOLING_VALIDATION）

1. **win32 优雅关闭适配**（`validation/remediation-win32-collector-wire/`）：Windows 无法投递 SIGTERM（TerminateProcess 先于 handler），collector-wire.spec.cjs 第 27 行改平台分支——win32 用 `C.atomicJson` 写 guard-result 由 collector 既有轮询触发同一 `finish()` 出口，非 win32 保持原 SIGTERM；退出等待加 10s race 超时。tools/ 零改动。
2. **rollup 属性消除产物的 dirty 解析**（`validation/remediation-rollup-folded-dirty/`）：冻结构建器下真实产物 `BUILD_INFO` 的 `dirty` 属性被 rollup 消除（非测试消费方仅引用 tag/commit/tree/deployBranch/bundleHash）。`buildIdentity` 增加 `folded_out` 识别（三常量引用签名 + 全文无 BUILD_DIRTY 痕迹，否则维持 `not_read` fail-closed），`confirmBuild` 额外接受该形态；不改产物、不改构建器。清洁树等价保障=prepare-session 前后两次 assertCandidate + 构建输出无脏树警告。

修复后回归：100/100 工具测试、5/5 故障变异、verify-package 46 文件（INTEGRITY.json 同步更新）。

## 离线验收（原样）

verify-package、100 项工具测试（首跑 99/1→修复后 100/100）、mutation-check 5/5、candidate-boundary `PINNED_CANDIDATE_BOUNDARY_VERIFIED`（真实候选+真实构建树各一次）、check-profile off、独立反例 11 项（八类全覆盖+合法正对照，见 tests-originals/independent-counter-cases.*）。

## 上轮原件找回

`previous-round-recovered/`：70 项 Node 测试 TAP（compat-node-all.tap）、3 suites/8 tests 计数器修复 Jest JSON（counter-fix-jest.json/stdout）。**类型检查原件未找回**：上轮 executed-summary 明确 `fullRepositoryTypecheckExecuted:false` 且本机无未跟踪 tsc 输出，如实记录；本轮对最终 profile 另行完成 `tsconfig.build.json` 与 `tsconfig.json` 双 `tsc --noEmit`（构建树，均退出 0），记录于本报告时间线与 buildMeta 溯源。

## 观察判读

- **样本：0**。S=73624800 到达前中断（中断时 tick≈73624500），桥从未激活（tick<startTick 阶段不读 Game/Memory，离线 smoke 已验证）。
- **对照项**（authorizesActions/spendable/kernelLifecycleRun/facadeQueryRun、directStatus、coreComparison 等）：无线上数据，不声称覆盖；不把离线结论伪装成线上观察。
- **中断原因**：collector 的 WS 流停止（02:16:25 最后 console 帧）后进程 exit 1 且无 footer；根因证据有限（后台任务仅捕获 stdout，stderr 缺失），如实记录为"未定因异常中断"，不猜测。guard 全链审计完整（guard.jsonl/guard-result.json/restore.jsonl）。
- **恢复三重确认**：恢复子进程回读 `RESTORED_AND_VERIFIED`；本会话独立 user/code 回读=原件（摘要+字节+BUILD_COMMIT）；60 秒 cpu 帧监听证明主循环执行。恢复后 `[deploy]` 宣告帧因 collector 已退出未捕获，以字节回读+cpu 帧替代运行身份证据，如上如实记述。
- **线上遗留**：原件字节（06ffedb 构建）。Memory.runtime 在候选运行的 ~5 分钟内仅可能被 announceDeploy 写过部署身份（候选主循环其余行为=旧业务，离线验收已证 profile 未激活时桥零读写）。

## 目录

- `package-and-tooling/`：实际执行的工具源码（18 个 cjs）、INTEGRITY.json、任务书、制作方 validation 与两份 TOOLING_VALIDATION（含全部 diff 与重跑 TAP）
- `tests-originals/`：包测试原样与修复后三轮 TAP、变异检查、candidate-boundary、独立反例套件
- `previous-round-recovered/`：上轮找回原件
- `run-records/`：前检摘要（initial/final）、session 身份摘要、上传/恢复/守卫全链 JSONL 与终态、heartbeat 终态、console.jsonl（423 帧，已验证不含凭据；完整线上模块快照不入库，保留于受控 run 目录）
- `probe/`：60 秒只读运行确认脚本与输出
