# Guard Joint Probe II · 完整实现验证运行 · 执行报告

- 日期：2026-09-11 / 2026-09-12（本地 UTC+8）
- 任务包：`screeps-treasury-compat-guard-joint-probe-II-complete-implementation-verification-task-package-2026-09-11.zip`
- Agent 角色：verification-only（零实现修改、零上传、零 compat 变更）
- 运行环境：Windows 10 (win32 10.0.26200 x64)、Node v22.19.0、Git Bash

## 终态

```text
GUARD_JOINT_PROBE_COMPLETE_IMPLEMENTATION_VERIFIED
GUARD_COLLECTOR_CONTROL_PLANE_PROBE_FAILED
NOT_DEPLOYED
```

探针本体与全部前置离线验证均通过；独立验证器 `verify-joint-probe` 的联合 heartbeat 行数硬门禁未过（287 < 295），按任务书 §5.5 规则判定探针启动后失败。未重跑探针、未放宽阈值、未修改包或 toolkit。

## 1. 基线（§1）

`verify-current-heads` → `GUARD_JOINT_PROBE_BASELINE_VERIFIED`：

- refactor/empire-treasury-rearchitecture = eb00879a1ff71275ff32e310378d3590fc910e6a，本地/远端一致，干净
- compat/treasury-read-bridge-i = fcfc125f0e5cd6c3370318b4fee0450f4d09af53，本地/远端一致，干净

## 2. 包与实现验证（§3）

| 步骤 | 结果 |
| --- | --- |
| verify-package | `PACKAGE_INTEGRITY_VERIFIED`（69 文件，exactFileSet） |
| validate-materializer-layout | `TOOL_BASE_LAYOUT_CONTRACT_VERIFIED`（25/25 映射） |
| validate-probe-decoupling | `CONTROL_PLANE_PROBE_DECOUPLING_CONTRACT_VERIFIED` |
| verify-implementation-overlay | `GUARD_JOINT_PROBE_IMPLEMENTATION_TESTS_VERIFIED` 56/56 |

## 3. Toolkit 构造（§4）

- materialize-toolkit → `COMPLETE_IMPLEMENTATION_MATERIALIZED`（baseFiles=25，overlayFiles=27）
- verify-toolkit → `GUARD_JOINT_PROBE_COMPLETE_IMPLEMENTATION_VERIFIED` 72/72（基底 16 + 实现 56）
- toolkit 落位 Git 外：`D:/code/screeps/guard-joint-probe-II-toolkit`
- 附：对已存在输出目录的第二次 materialize 被 writeNew 幂等保护拒绝（`OUTPUT_ALREADY_EXISTS`），行为符合预期

## 4. 联合探针（§5）

- prepare-control-plane-probe → `CONTROL_PLANE_PROBE_SESSION_PREPARED`
  - runId `9d4b36954b8450f8a657627da71f146d`、durationMs 1500000、observedTick 73636408
  - `$RUN` 仅含摘要与 probe session（无 session.json/backup.json/candidate.json/upload-attempt.json）
- collector（PID 32772）+ wait-ready → `PROBE_COLLECTOR_READY`，console/CPU 双通道新鲜
- guard-probe 单次连续 25 分钟（2026-09-11 23:41:43 → 00:07:33 本地，无重启、无拼接）：
  - 进程结论 `GUARD_COLLECTOR_CONTROL_PLANE_PROBE_VERIFIED`，reason `probe_complete`
  - durationMs 1500460 ≥ 1500000；firstTick 73636421 → lastTick 73636790（单调）
  - 时间通道：99 次成功读取（≥98）、1 个完整失败周期（≤1）、结束连续失败 0
  - collector PID / runId 全程不变；exit 双 0；恰好一个 `probe_complete` footer
- postflight-control-plane-probe → `PROBE_ONLINE_STATE_UNCHANGED`
  - digestHash 前后一致（84f76975…）、BUILD_COMMIT 06ffedb 一致、tick 73636408 → 73636832
- scan-probe-evidence（含 verify 失败证据后全量重扫）→ `PROBE_EVIDENCE_SECRET_SCAN_CLEAN`
  - 29 文件 259930 字节、4 类 needle（raw/url-encoded/prefix-8/prefix-16）、0 命中

## 5. 失败：verify-joint-probe（§5.5）

```text
PROBE_HEARTBEAT_TIMELINE_INVALID { expectedAtLeast: 295, actual: 287 }
```

- 失败点为联合 heartbeat 时间线行数门禁（verify-joint-probe.cjs:116）。该检查之前的全部检查均已通过：进程 exit、JSONL 合法、session 基线匹配、prepared 证据、postflight 证据、collector ready、时间通道稳定、collector 终态、最终 heartbeat、停止请求、footer、无 control failure、启动证据、tick 时间线单调
- 失败点之后未到达的 forbidden-artifact 检查经人工核对：`$RUN` 全程无 `upload-attempt.json`、无 `session.json`、无 `backup.json`、无 `candidate.json`
- 根因分析（只读统计 `guard-probe.jsonl`，未修改任何原件）：
  - 287 条 heartbeat，跨度 1495086ms（满足 ≥1490000 的跨度要求）
  - 间隔最小 5001ms / 中位 5097ms / 平均 5228ms / 最大 10033ms（最大间隔对应那 1 个失败周期的退避）
  - 设计按 5000ms 精确间隔推算 25 分钟应约 300 条，阈值 295 仅容 1.7% 余量；Windows 定时器漂移 + 失败周期退避造成实际平均 4.6% 偏差（287 条）
  - 结论：阈值边界设计缺陷（制造方 manifest `heartbeatEvidenceMinimumRows: 295` 对实际调度漂移余量不足），非执行中断或证据缺失；行数缺口 8 条全部可由每周期 ~228ms 漂移解释
- `joint-probe-verification.json` 因验证器在写出前失败而不存在；失败原件为 `verify-joint-probe.stderr`（两次运行同码同数值，证据链一致）

## 6. 操作备注（如实记录）

- 探针运行期间（23:47 前后），为将 §4 materialize 成功输出落盘，曾删除并重建 toolkit 目录一次：从同一固定 Git tree + 同一 overlay 哈希重新物化，重建后立即重验 72/72 字节合同一致；运行中的 collector/guard-probe 模块此前已加载入内存，不受影响（事后核验 collector PID 不变、heartbeat 连续、探针正常跑满全程）。该操作未改变任何被执行字节，但时序上不符合“运行期间不动 toolkit”的最严格解读，特此披露
- 任务包首次解压曾因管道截断不完整，`verify-package` 立即以 `PACKAGE_FILE_SET_MISMATCH` 拒绝；完整重新解压后通过。该失败输出未归档（发生在证据链正式开始前，重验后以完整包为准）

## 7. 归档内容

```text
online-observation-0002-guard-joint-probe-ii/
├── EXECUTION-REPORT.md            本报告
├── IMPLEMENTATION-APPLIED.json    固定字节物化声明
├── IMPLEMENTATION-MANIFEST.json   包内清单副本
├── task-package.zip               任务包原件
├── task-package.sha256
├── offline/                       §1/§3/§4 全部 stdout/stderr/exit
└── probe-run/                     §5 全部证据
    ├── prepare.{stdout,stderr}
    ├── secret-scan.json           全量重扫 CLEAN
    └── run/                       probe session、前后摘要、collector/Guard 原始证据、
                                    verify-joint-probe 失败原件、heartbeat、console.jsonl
```

未归档（按 §6 禁止清单）：`.secret.json`、token 及前缀（扫描 0 命中）、线上模块正文（前后检仅摘要）、backup/candidate（不存在）、全量 Memory（未读取）、未脱敏 HTTP body/header（无）、全机器进程命令行（无）。

## 8. 边界确认

- 零 Screeps code POST（codeWriteRequests=0，read-only client 仅 me/branches/code/time）
- 零候选上传、零 restore、compat 分支零提交零变化
- refactor 分支仅新增本 evidence 提交
- 未使用任何禁写终态标签
