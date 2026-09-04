# Round 22 Remediation VIII — Treasury 本地验证证据

## 概要

- 日期：2026-09-03
- 分支：`refactor/empire-treasury-rearchitecture`
- 预期起始 HEAD：`7f102d9901f80497b57403171508739ff520ab62`
- 实际起始 HEAD：`7f102d9901f80497b57403171508739ff520ab62`（一致——无差异）
- 最终代码/测试验证 HEAD：`10ff781996f818b8c7ec76ae42dca72075d36431`
- 最终分支 HEAD：见 push 后的远端 HEAD（evidence/budget 提交在其后——按惯例为非代码提交）
- 无独立 GitHub Actions / commit status——本文件记录的全部结果均为本地实际执行。

## Commit 清单与职责

| commit | 职责 |
| --- | --- |
| `51dd32b` fix(treasury): make issued attempt identities fully verifiable | 工作流 A：issuer v2 确定性 hash + contract 通道 ID 分类门禁 |
| `17490d6` fix(treasury): reconcile all durable settlement authorities | 工作流 B+C：统一 reconciliation 重写 + certificate 语义修正 + 权威分离 + retired range 孤儿 gap coalesce |
| `658fae4` fix(treasury): back cleanup completion with durable reservations | 工作流 D：prepare 顺序 + 成功路径释放 + handoff owner + TTL owner truth graph + 结构化 mutation |
| `d2f3da9` fix(treasury): bound terminal replay authority across long runtimes | 工作流 E（summary 层）：满载驱逐（certificate/range 接管后删旧条目） |
| `f6b69c0` test(treasury): cover remediation viii counterexamples | I1-I7 / S1-S9 / C1-C7 / R1-R13 / L1-L5 + S10 架构守护 + VII/VI 断言语义迁移 |
| `a3deed1` fix(defense): reserve physical rampart occupancy before allocation | 工作流 F：共享占用入口 + planner/fallback claim（Defense 正交提交） |
| `10ff781` test(defense): cover preallocation stationary ownership conflicts | D9-D15 + 共享入口守护 |
| docs/test(budget)（其后） | OpenSpec 文档 + evidence + budget（非代码提交） |

## 工作流 A：issued ID 完整验证方案

- authoritative hash 协议升级 `treasury-attempt-issuer@v2`：hash lane 只含
  protocol tag + sequence——每个已发行 sequence 恰好存在一个可验证的完整
  authoritative ID（I7：mint 与确定性重建恒等）；caller correlation 降级
  为纯 metadata（不参与 hash，无需 per-sequence 发行事实持久化）。
- 完整验证 = watermark（Memory 持久）+ 纯确定性重算——global reset 后不
  依赖任何 heap 对象（I5：reset 后合法 ID 仍 issued、篡改 checksum 仍
  legacy_unverified、watermark 不回退）。
- 旧 v1 hash（correlation 参与 lane）数据无法通过 v2 重算 →
  `legacy_unverified`：不得当作当前格式合法新 ID；replay blocker 语义由
  durable settlement authority / retired range 按 ID 承载（不丢失）。
- arbitrary ID runtime gate：production contract 通道（registry sealed =
  生产装配的 runtime 权威标志）对 tr1_ 之外、非 ti1_ 的任意字符串
  （含 ts1_ / tt1_）一律拒绝 `transaction_id_not_issued` /
  `transaction_id_not_service_issued`（I2/I3——不再只依赖架构测试约束
  调用方）。测试域（unsealed）保留受控入口、与 production channel 明确
  隔离（I3 的隔离验证分支）。
- issuer store 损坏（版本未知 / watermark 非安全整数）→ mint / build /
  check / contract 全链 fail closed（I6）。

## 工作流 B：统一 settlement reconciliation

- 来源与裁决：live completion → historical completion → chain
  certificate（root byRoot + tr1_ child byLineage+checksum）→ retired
  range **全部收集后统一裁决**（无 first-match 短路）。
- 冲突优先级：任一相关来源 store_unhealthy → `store_unhealthy`（S2：
  live exact 不遮蔽后方损坏）＞ 权威间矛盾 → `conflict`（S1：live
  committed vs historical not-executed；S3：historical vs certificate 相反
  结论；S5：outcome 相同 durable identity 不同）＞ 多来源一致 → exact
  （S4：outcome/profile/proofClass/durable identity 全一致才共同证明）＞
  retired（anti-reuse-only）＞ 全部 healthy 且 absent → absent（S9）。
- expectedOutcome / expected（exact identity）由全部声明共同验证；identity
  比较用统一 relation 语义（conflict → conflict；insufficient 不选边阻断
  ——正常流程的维度缺失 proof 不被误判为身份冲突）。
- 接入面：facade prepare replay gate（exact 与 protocol 等效阻断）、
  oppositeProofMatrix（两方向）、currentSettlementCoordinator（5.5 与
  opposite-absence）、attemptOccupancy（rearm preflight + child
  occupancy）、facade issueTreasuryReconciliationCapability（protocol →
  拒绝——destructive 不用协议推导）、resolutionCleanupCoordinator /
  cleanupStageAcknowledgement（journal-absent 判定）。S10 架构守护：
  安全关键模块不得直接调用底层 lookup（白名单：resolver / 底层实现 /
  压缩编排）。
- settlement 与 cleanup completion 权威分离（B3）：
  `resolveTreasuryCleanupCompletionAuthority` 只认 live completion（五阶段
  全部持久确认后写入）与 historical completion（显式 supersession）；
  chain certificate / retired range 只证明 settlement outcome，不证明
  marker discharge / authority release / outcome finalization / lineage
  finalization / journal deletion（S8：journal absent + 只有 certificate
  → no_cleanup_authority，不得 completed）。

## exact / protocol-derived / retired 的区分（C4）

- `exact`：live/historical completion——完整 exact identity 可验证，可进
  destructive 路径；
- `protocol`：chain certificate 的协议推导 outcome（root/final/中间代
  确定性映射）——identity 不足；replay gate / opposite proof / occupancy /
  reconciliation 一致认识并阻断（S6）；marker discharge / authority
  release / cleanup completion / resolution relabel 等 destructive 路径
  不使用（C7：reconciliation capability → resolution_identity_conflict；
  cleanup 查询 → no_cleanup_authority）；
- `retired`：anti-reuse-only（retired range / 被驱逐 certificate）——不带
  outcome、不升级 exact、阻断新执行（S7）。

## chain certificate outcome 规则（C2）与 tr1_ checksum（C3）

- finalGeneration=0：chain_committed → root committed；
  non_rearmable_retired → root not-executed；
- finalGeneration≥1（chain_committed）：root 与全部中间代 not-executed，
  finalGeneration committed（C1/C2）；
- finalGeneration≥1（non_rearmable_retired）：root 到 final 全部
  not-executed（C3）；
- tr1_ child：解析 lineageId/generation 后用 certificate 的
  rootTransactionId 重算 checksum——改一位即不属于该 chain（C4 测试：
  absent）；generation > finalGeneration → absent；
- canonical 关系验证（C6）：finalGeneration=0 → finalAttemptId === root；
  ≥1 → v2 child 形态 + lineage/generation 匹配 + checksum 派生一致；
  rootSequence 与 root 发行序号一致——违反即整条损坏（store load 与单条
  lookup 都拦截，resolver store_unhealthy）。

## reservation 生命周期（D）与中断窗口

- acquire（prepare 最后一步纯验证之后）→ bind（execute final admission
  前）→ transfer/consume（matching handoff）/ release（普通成功 / abort /
  拒绝路径）；
- handoff 顺序：matching reservation admission → completion 写入 →
  read-back → consume（checked）→ journal 删除；
- 中断窗口 R9：completion 写入后 consume 前 global reset → beginTick 的
  matching pair recovery 识别并完成 consume（无双计数；identity 冲突的
  pair 保留 fail closed）；
- 中断窗口 R10：consume 后 journal 删除前中断 → completion 是恢复权威，
  journal 幂等继续（advance → completed）；
- TTL owner truth graph（R11/R12）：intent / quarantine / cleanup journal
  / resolving resolution（tombstone probe）/ authorization fault /
  write-fault marker / 活跃 lineage（lineage probe）/ matching live
  completion 任一在位即 owned；owner store unhealthy 视为 owned（不把
  "读不到"解释成 orphan）；probe 经 assembly 注入（模块环 TDZ 规避）；
- 容量不变量（D5）：effective occupancy = live + reserved − matching pairs
  （同一 handoff 只计一槽）；R6：live=MAX−1 + A 持有最后 reservation 时，
  B 的无 matching reservation publish 经 recovery acquire → reclaim →
  retry 仍失败 → reservation_unavailable（journal pending，不写
  completion——有效占用从未超过 MAX）。

## 长期有界结果（E）

- **>128 terminal chains（L1）**：161 条真实终态链（正式
  seedRearmReadyRoot/seedNonRearmableRoot converge 状态迁移 →
  compactTreasuryTerminalLineage）全部 compacted 成功；第 161 条新链
  仍能创建——summary 128 满载驱逐（certificate 在位 guard）生效；
  certificate ≤256。
- **乱序退休碎片（L3）**：奇数 seq（1..131，66 个区间）先退休、偶数
  mint 后未用 → 满载触发孤儿 gap coalesce（偶数 abandon 桥接）→
  区间数 ≤64、继续创建新链不停机；在飞 hole（quarantine 在位）不误退休。
- **>384 historical 边界（L4）**：400 笔真实 issuance + 正式 lifecycle
  （真实 execute committed + 完整 cleanup；completion 满载后由
  publication admission 的 reclaim-then-retry 正式通道 archive）→
  historical ≤384、旧 ID 全部不可重放（exact/retired/protocol——无一
  absent）、新 writer 正常执行（callback 恰一次）。
- **global reset 后 permanent authority（L5）**：watermark 不回退、30 条
  链的 root 无一恢复 absent/new、issued ID 完整验证仍成立。

## 验证命令与真实数字

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| `npm run build` | 成功（bundle sha256 见部署记录） |
| `npx jest --config jest.config.cjs src/runtime/treasury/treasuryRound22RemediationVIII.test.ts src/runtime/treasury/treasuryRound22RemediationVII.test.ts src/runtime/treasury/treasuryWriteArchitecture.test.ts` | 3 suites / **114 tests** 全过 |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 73 suites / **1426 tests** 全过 |
| `npx jest --config jest.config.cjs`（全仓） | **274 suites / 2255 tests / 2255 passed / 0 failed / 0 pending / 0 todo**（exit 0） |
| `node scripts/verify-jest-budget.mjs` | PASSED（budget 更新后） |
| `git diff --check` | 干净 |
| `sha256sum dist/main.js` | `c730c3e2ea6fb78600ac58f0ece257bd210e9851a7386dbe65cd4d413cbbba00` |

（定向 Defense 结果见 Defense evidence。）

## 声明

- 未部署到 Screeps；未合并 main；未 reset/rebase/force push。
- 未调用真实 terminal.send() / market / lab / factory / nuker / carrier——
  全部 Game 交互使用 mock/spies。
- 无独立 CI——本报告为本地实际验证结果。
