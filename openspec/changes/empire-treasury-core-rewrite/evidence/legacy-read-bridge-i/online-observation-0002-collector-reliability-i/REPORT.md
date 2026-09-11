# Treasury Legacy Read Bridge I — Online Observation 0002

## Collector Reliability I + 一次限定线上观察

**最终标签：`ONLINE_COMPAT_READ_INCONCLUSIVE / RESTORED`**

一句话结论：collector 可靠性本轮已被证明（20.7 分钟无上传探针通过，上一轮的模糊 `collector_stalled` 已细分为具体终态），唯一一次上传成功并回读校验通过，但 guard 在观察窗口开始前因外部网络中断 fail-closed 关闭，12 个采样点全部缺失；线上已精确恢复为前检备份原字节，并由独立回读与主循环运行帧双重确认。

---

## 1. 起止 SHA

| 项 | 值 |
|---|---|
| refactor 分支起点/终点 | `f4204c2b4c0bc3637ac0347e8d87b23d516bb934`（未变更，本轮未改 refactor 源码） |
| compat 分支起点 | `91532745123ca14cddb78385f9a88800fca4bf1a` |
| `PROBE_PROFILE_HEAD` | `18d2db62d53bfe317d15025d6a258ce7ba1f5a5b` |
| `PROFILE_HEAD` | `104e47b9d55adedc35f484045ef333fabb6073f4` |
| `CLOSED_SOURCE_HEAD` | `fcfc125f0e5cd6c3370318b4fee0450f4d09af53` |

三个 compat 提交彼此之间、以及与起点 `9153274` 的差异**仅** `src/runtime/treasuryCompatConfig.ts`（逐提交 `git diff --name-only` 验证；`CLOSED_SOURCE_HEAD` 与 `9153274` 内容差异为 0 行）。

构建身份（分别记录，未混写）：

| 用途 | Git HEAD | tree | 内嵌 bundle hash | main 字节 / sha256 |
|---|---|---|---|---|
| 线上前检备份 | — | — | — | 4494463 / `37d207…` |
| 探针（未上传） | `18d2db6` | — | `80f4299794f0700a…` | — |
| 正式候选 | `104e47b` | — | `c2ca395a824645df…` | 4586886 / `6951a3b5…` |
| 关闭构建（未上传） | `fcfc125` | — | `0d517020fec3074d…` | — |

模块集合摘要：backup `84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf`，candidate `5e8bda4265e9b1746fe4302a3c6b9469227cf0a52c57daf6803eea4fdb46115b`，逐模块差异 = 仅 `main` 变化（`06-online-run/module-digests.json`）。

## 2. 补丁应用与工具修复

三份补丁**原样应用**，无 reject、无手工拼接（`02-tooling/PATCH-APPLICATION.json`，含三个 patch 的 sha256）。基底由 17 个固定 Git blob 逐字节构造并核验（`PATCH_BASE_VERIFIED`）。

**存在一次工具修复**，身份如下：

- 文件：`02-tooling/TOOLING_REMEDIATION-common-atomic-json.diff`
- 记录：`02-tooling/TOOLING_REMEDIATION.json`
- 范围：仅 `common.cjs` 的 `atomicJson`
- 根因：Windows 上 `fs.renameSync` 覆盖被另一进程打开读取的目标文件会间歇性 `EPERM`。复现（`02-tooling/win32-rename-race-repro.cjs` / `.txt`）：无并发读者 0/400 失败；有 5ms 并发读者 11–25/400 失败，全部为 `EPERM rename`。
- 修法：对 `EPERM/EACCES/EBUSY` 有界重试（6 次，20–120ms 退避）；仍被占用则改为原地覆盖，避免丢失证据（非原子心跳可存活，缺失心跳会终止本轮）。
- **未**借工具修复改动候选源码、guard 语义、上传门禁或恢复条件。

## 3. 测试结果

### 原始 16 项（制作方补丁自带）

| 轮次 | 结果 | 证据 |
|---|---|---|
| 原样重跑（修复前） | **15/16**，失败项 `cross-platform file request produces a clean probe terminal record` | `02-tooling/tool-tests-original.tap` |
| 修复后 r1–r4 | **16/16 ×4 连续通过** | `tool-tests-r1..r4.tap` |

### Agent 独立反例（`agent-independent/`，不改动原始测试）

24 项，覆盖任务书 §4 要求的全部条目：error 后无 close / error 后迟到 close / close 缺 code·reason / result 文件损坏 / 外来 runId / 心跳新鲜但 console 静默 / console 新鲜但 socket 已 closed / 重复 footer / stop 请求外来 runId 与非法 reason / 私有诊断注入 fake token·URL token·36hex / collector-result 写盘失败 / heartbeat 写盘失败 / SIGINT 与文件关闭请求的 Windows 行为（以同名目录占位构造跨平台确定的写盘失败）/ atomicJson 跨进程并发覆盖。

| 轮次 | 结果 | 证据 |
|---|---|---|
| 修复后 r2–r4 | **24/24 ×3 连续通过** | `03-independent-tests/independent-cases-r2..r4.tap` |
| **反向对照**：未修复的 common.cjs | **22/24**（失败：positive control、并发覆盖） | `03-independent-tests/independent-cases-as-shipped-common.tap` |

反向对照成立，证明修复是这两个用例通过的必要条件。

工具集在正式探针前固定摘要（36 文件），之后复核 `FROZEN_MANIFEST_UNCHANGED`（`02-tooling/actual-tool-hashes.txt`、`frozen-manifest-verification.json`）。

制作方 16 项与候选历史 195/685、完整 Treasury 248/1539 **未被混为一个总数**。

## 4. 无上传稳定性探针

| 项 | 值 | 证据 |
|---|---|---|
| 状态 | `COLLECTOR_STABILITY_PROBE_VERIFIED` | `04-probe-no-upload/probe-verification.json` |
| 持续时间 | **1,242,625 ms（20.7 分钟）**，超过上一轮约 14 分钟中断点 | 同上（durationMs） |
| 认证时刻 | `authenticatedAtMs` 存在且完整 | `probe-heartbeat.json` |
| console/CPU 覆盖 | 两频道自认证后持续出现，末帧距关闭约 2.3 秒 | `probe-heartbeat.json`、`04-probe-no-upload/probe-heartbeat-timeline.jsonl` |
| footer | 606 帧中**恰好 1 个**，runId 一致 | `probe-console.jsonl` |
| 终态 | `status=closed`、`reason=probe_complete`、`exitCode=0` | `probe-collector-result.json` |
| 上传 attempt | **全程不存在** | run 目录检查 |
| 进程退出 | shell 退出码 0，stdout/stderr/PID 全部归档 | `probe-collector.exit.txt` 等 |

## 5. 唯一一次上传 attempt

| 项 | 值 |
|---|---|
| dry run | `DRY_RUN_WOULD_UPLOAD`（`requestAttempted:false`） |
| 唯一启用 POST | `UPLOADED_AND_READBACK_VERIFIED`（`requestAttempted:true`、`serverAccepted:true`、`confirmed:true`） |
| attempt 文件 | 已生成，含 runId/candidateHash/profileHead |
| 重复调用 `--execute` | 未发生（一次性门禁生效，attempt 文件未被删除或改写） |

## 6. 采样点结果

| 项 | 值 |
|---|---|
| 12 个预定样本实际获得 | **0** |
| 完整样本 | **0** |
| 缺失 tick | 全部 12 个（`73631900` … `73633000`） |
| console 帧总数 | 386（全部为握手/心跳帧，含 `treasury-legacy-read-bridge` 的帧 **0** 条） |
| CPU 可归属样本数 | 0（无 `previousRun.cpuIncludingEmit` 可归属） |
| 最末样本成本口径 | 不适用——无采样点到达 |

关闭发生在 tick≈73631640，距 `S=73631900` 尚有约 260 tick，窗口从未开始。属结构性缺失，非「只差一条」。

## 7. guard 具体关闭原因

`guard-read_or_channel_failure`（原始产物 `ONLINE_CLOSE_UNCONFIRMED`）。

guard 主循环兜底捕获未保留具体异常，故根因基于证据推断：guard 循环内唯一不受内部保护的抛错源是 `api.time()` 网络调用。同期本 Agent 的只读调用**两次独立遭遇 `HTTP_TRANSPORT_ERROR`**，且 collector 的 WS 帧在关闭前中断。故判定为**外部网络中断**，guard 正确 fail-closed 关闭并触发恢复。详见 `08-analysis/guard-failure-analysis.md`（含完整时间线与逐条排除依据）。

本轮 guard **未**退化为上一轮的笼统 `collector_stalled`。但其自身通道异常仍归入统一兜底，未区分「网络中断」与「文件读取失败」——属本轮新发现的可改进点，**未修改**（超出任务书修复授权范围，且现有行为已满足安全要求：未误报成功、未伪造恢复确认）。

## 8. 精确恢复与关闭确认

| 检查 | 结果 | 证据 |
|---|---|---|
| 恢复 POST | 服务器接受（`serverAccepted:true`），回读因网络失败未确认 | `06-online-run/run-restore-result.json` |
| **独立只读回读 1** | `CURRENT_IS_BACKUP`（逐模块内容匹配，`84f769…`） | `07-restore/online-state-verdict-attempt1.json` |
| **独立只读回读 2** | `CURRENT_IS_BACKUP` | `07-restore/online-state-verdict-3.json` |
| 账号 / 活动分支 | `forster` / `634fe406347a7b69b28aeccb`，`default` 唯一 `activeWorld` | 同上 |
| 线上 main | 4494463 字节 / `37d207…`（与前检备份逐字节相同） | 同上 |
| **恢复后主循环运行** | `RUNTIME_CONFIRMATION_MAIN_LOOP_RUNNING`：19 个 CPU 帧、18 个 console 帧（CPU 实测 58–88） | `07-restore/runtime-confirm-probe.json` |
| 未用旧备份覆盖第三方代码 | 恢复前判定为 `CURRENT_IS_CANDIDATE` 路径（非第三方），无冲突 | restore 逻辑与判决文件 |
| Memory | 未恢复、未写入 | 工具仅调用 `/api/user/code` |

## 9. `CLOSED_SOURCE_HEAD` 默认 OFF 证据

- 文件：`src/runtime/treasuryCompatConfig.ts`
- sha256：`ff291683faf1a2a3711f231b9affe7d1cd759416c3482dc77563cfd9a628ab02`（与 `9153274` 原字节一致）
- `git diff 9153274 fcfc125` 内容差异 = **0 行**
- `check-profile --mode off`：`PROFILE_SOURCE_VALIDATED_ONLY`（`07-restore/check-profile-closed-off.json`）
- 双 TypeScript 检查：`tsconfig.build.json` 与 `tsconfig.json` 均 exit 0
- 关闭构建：`No deployment target set. Build only.`，**未上传**（`07-restore/closed-build.log`）
- 基线回归：`JEST_TEST_BUDGET=PASSED`，**195 套件 / 685 用例全部通过**（OFF 恢复未破坏既有验收基线）

## 10. 最终标签与未验证事项

**最终标签：`ONLINE_COMPAT_READ_INCONCLUSIVE / RESTORED`**

依据：12 个采样点全部缺失（任务书 §10 的 INCONCLUSIVE 条件）；恢复已由独立只读回读 + 恢复后主循环运行帧双重确认（RESTORED 条件满足）。未因只差样本而开启第二窗口，未产生第二次启用上传。

未验证事项：

1. **兼容桥的线上行为完全未验证**——零个 bridge 样本，`directStatus`、`coreComparison`、`commitments.status`、`previousRun.cpuIncludingEmit` 等 §10 判据全部未取得任何观测值。
2. **guard 内部通道异常的细分**——`guard_read_or_channel_failure` 未细分为网络/文件类，未做故障注入验证。
3. **collector 未复现上一轮 14 分钟中断**（本轮 20.7 分钟探针通过），但该中断的原始触发条件仍未被独立定位。
4. Windows 文件锁/信号行为仅在本次实际使用的路径上验证（含本轮发现的 rename 竞态），非全量覆盖。
5. 制作方声明的「操作系统强制终止/断电无法产生 footer」这一硬限制本轮未做破坏性验证。

## 11. 证据索引

```
online-observation-0002-collector-reliability-i/
  00-task-package/     原任务 zip + sha256、PATCH-BASE.json、三份原样 patch
  01-baseline/         起点核对、token 状态、OFF 前检
  02-tooling/          PATCH-APPLICATION、as-shipped 快照、TOOLING_REMEDIATION diff、
                       rename 竞态复现、16 项各轮 TAP、冻结摘要与复核
  03-independent-tests/24 项各轮 TAP、反向对照 TAP
  04-probe-no-upload/  探针 profile 校验、session、stdout/stderr/PID/exit、
                       heartbeat 时间线、console、collector-result、验证器输出、秘密扫描
  05-profile-and-build/正式窗口选择、profile 校验、冒烟、双 TS、最终前检、session
  06-online-run/       上传 dry-run/execute、attempt、collector/guard 全部产物、
                       window-monitor 时间线、模块摘要
  07-restore/          独立回读判决 ×2、恢复后主循环确认、off 校验、关闭构建日志
  08-analysis/         guard 失败分析
  REPORT.md            本文件
```

线上模块完整正文、原始凭据与全量 Memory 保留在受控工作树外（`D:/code/screeps/run-0002/`），仓库内仅存摘要与必要脱敏证据。
