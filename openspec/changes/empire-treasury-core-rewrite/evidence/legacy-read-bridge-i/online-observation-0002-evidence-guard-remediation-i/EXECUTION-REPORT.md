# Evidence & Guard Remediation I · 实现验证执行报告（v2 包）

- 日期：2026-09-11
- 任务包：`screeps-treasury-compat-online-observation-0002-evidence-guard-remediation-I-implemented-verification-v2-task-package-2026-09-11.zip`
  SHA-256：`44044f2ad971f74cfa1ef755ba5844c59126dfacd0d6e7cf107fa1a417157c04`
- 取代：SHA-256 `a70d615b…3842` 的 v1 包（v1 终态：transforms 自带禁用串 vs verify 朴素 includes 自相矛盾，零提交零上传）
- Agent 角色：仅验证（应用固定字节、运行测试、只读联合探针、归档证据）

## 终态

```text
EVIDENCE_REMEDIATED
GUARD_CONTROL_PLANE_IMPLEMENTATION_VERIFIED
JOINT_PROBE_NOT_RUN_PINNED_WINDOW_EXPIRED   ← 联合探针未能启动（session 无法合法构造）
NOT_DEPLOYED（零上传、compat 零提交零变化）
```

说明：§8 预设三组终态均不覆盖“探针因固定窗口过期而无法构造”的情形。为不夸大也不缩水：
- 不写 `GUARD_COLLECTOR_CONTROL_PLANE_PROBE_VERIFIED`（探针未运行）；
- 不写 `GUARD_COLLECTOR_CONTROL_PLANE_PROBE_FAILED`（探针未在采集线上数据后失败，而是构造阶段即被固定 profile 拒绝）；
- 采用如上中性标签，并以 `probe-not-run/window-expiry-diagnosis.json` 支撑。

## 执行结果

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| §1 基线 | PASS。fetch 后 refactor=`d6445029…`、compat=`fcfc125f…`，本地=远端，两树干净 | 本报告 |
| §3 包完整性 | PASS。`PACKAGE_INTEGRITY_VERIFIED`（58 files，v2，exactFileSet） | `offline/01-verify-package.json` |
| §3 transform 契约 | PASS。`REPOSITORY_TRANSFORM_CONTRACT_VERIFIED`（files=2/replacements=11/deletions=3，reportPolicy=pass，analysisPolicy=pass，forbiddenMutantsRejected=2）——v1 自相矛盾已在包内修复并经反向对照证实 | `offline/02-validate-transforms.json` |
| §3 materializer 布局契约 | PASS。`TOOL_BASE_LAYOUT_CONTRACT_VERIFIED`（25/25 映射，4 基底 spec + 1 支撑文件入 tests/，flattenedMutantsRejected=1） | `offline/03-validate-materializer-layout.json` |
| §3 固定实现测试 | PASS。25/25 | `offline/04-implementation-tests.tap` |
| §4 整改预检 | PASS。`targetPolicy:"pass"` | `offline/05-apply-precheck.json` |
| §4 应用+验证 | PASS。`REPOSITORY_REMEDIATION_APPLIED` → `REPOSITORY_REMEDIATION_VERIFIED` | `offline/06/07` |
| §4 历史 blob 秘密扫描 | PASS。`HISTORICAL_BACKUP_SECRET_SCAN_CLEAN`（3 blob：c262f97/ea8bff7/2527301，totalHits=0；产物不含 token 原值/URL 编码/前缀） | `../online-observation-0002-collector-reliability-i/09-remediation/historical-backup-secret-scan.json`、`offline/08` |
| §4 提交1 | `EVIDENCE_REMEDIATION_HEAD = c37b2c18762cc5a2e48f48e23900518e7d569a11`（11 文件，仅 evidence 路径） | git 历史 |
| §5 materialize | PASS。25 基底 + 7 overlay，`baseTestsMappedUnderTests=4` | `offline/09-materialize.json` |
| §5 verify-toolkit | PASS。**41/41**（v1 隐患修复后可达） | `offline/10-verify-toolkit.json`、`offline/11-toolkit-tests.tap` |
| §6.1 detached 构建树 | PASS。`104e47b…`，compat 主树始终 `fcfc125…` 干净 | 本报告 |
| §6.2 preflight-before | PASS。`PREFLIGHT_VERIFIED_NOT_DEPLOYED`，forster/shard1，observedTick=73635026，线上=06ffedb（生产基线未变） | `probe-not-run/preflight-before.*` |
| §6.2 prepare-session | **FAIL ×2**。`{"error":"UNEXPECTED_LOCAL_FAILURE"}`；分步复现真实原因为 `insufficient pre-upload lead; do not extend an already uploaded window` | `probe-not-run/prepare-session.*`、`probe-not-run/window-expiry-diagnosis.json` |
| §6.3–6.5 | **未执行**（session 不存在；未启动 collector/guard-probe；未上传） | — |

## 根因：固定探针窗口已被线上 tick 越过

- pinned profile 提交 `104e47b9…` 绑定窗口：`startTick=73631900`、`endTick=73633000`（12×100 tick，双房间 E3N59/E4N58，energy/H）。
- preflight 实测线上 tick `73635026`：窗口终点已被越过 2026 tick；`startTick` 距“最小合法值 observedTick+100=73635126”短缺 3226 tick。
- check-profile.cjs 规则 `cfg.startTick >= observedTick + 100` 永不满足（窗口固定于 pinned 提交，线上 tick 单调前进）。
- AGENT-RUN §6 明令禁止换窗口、复用拼接、现场修改阈值；bridge/config 源码 SHA 被 check-profile 锁定。故 session 构造在法律上永久不可行，探针按规则中止。
- 附注（诊断掩码，非独立缺陷）：check-profile 抛出的是普通 Error，被 common.cjs safeFailure 统一掩码为 `UNEXPECTED_LOCAL_FAILURE`，包未提供专门的窗口过期错误码；本报告经分步复现还原真实原因。

## 与 v1 失败的关系

v1 的 transforms/verify 自相矛盾在 v2 已修复并被本轮 §3 反向对照与 §4 实际 apply→verify 双重证实；v1 的 materializer 扁平化缺陷同样修复并被 §5 的 41/41 证实。本轮唯一的未达项是 §6 联合探针，且其原因是任务包固定输入（pinned 窗口）与线上时钟的相对关系，不是 v1/v2 已修复的两缺陷，也不属于实现质量问题。

## 失败处置

- 未修改包源码、未添加测试、未放宽门禁、未换窗口、未重跑拼接。
- collector/guard-probe 从未启动；`run/` 目录从未创建；无 upload-attempt 任何产物；线上模块在 preflight-before 中与生产基线 06ffedb 完全一致（探针未触碰线上）。
- 失败原件：`probe-not-run/`（preflight 摘要 + prepare-session 两次失败 stdout/stderr/exit + 窗口过期诊断 JSON + 调试工具 `debug-session-tool.cjs` 存外部运行目录）。
- detached 构建树在归档后移除；compat 分支全程零提交零变化。

## 秘密卫生

- 曾有一次调用失误（把 token 值当作 `--secret` 路径传入扫描器），错误信息中含 token 的 ENOENT 消息被立即删除，未进入任何归档；正确调用后产物经核验不含 token 原值/URL 编码/前缀。
- 本 evidence 目录提交前已做最终秘密扫描（token 原值、URL 编码、8/16 前缀）——结果 CLEAN。
- 未归档：完整 backup.json、candidate.json、.secret.json、token、全量 Memory、未脱敏 HTTP、全机器进程命令行。

## 证据清单

```text
IMPLEMENTATION-MANIFEST.json                  v2 包清单
task-package-v2.zip / .sha256                 任务包原件与哈希
offline/01…11                                 §3/§4/§5 全部 stdout/stderr/TAP/exit
offline/IMPLEMENTATION-APPLIED.json           materializer 应用记录
probe-not-run/preflight-before.*              §6.2 前检（含摘要 JSON）
probe-not-run/prepare-session.*               §6.2 两次失败原件
probe-not-run/window-expiry-diagnosis.json    窗口过期根因与算术
EXECUTION-REPORT.md                           本报告
```
