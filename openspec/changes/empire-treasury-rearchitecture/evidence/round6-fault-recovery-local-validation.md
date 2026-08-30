# Round 6 — Fault Recovery & Authority Integrity 本地验证证据

> 本文档记录 Treasury Round 6（Fault Recovery & Authority Integrity）的本地
> 验证过程与真实结果。**未执行 live deployment**（未调用 `npm run push`、
> 未上传任何代码到 Screeps 服务器）；本仓库无 GitHub CI 配置（无
> `.github/workflows`），全部验证为本地确定性执行，**不声称 CI passed**。

## 提交范围

- 起始 HEAD：`876543543b120a725745d0c3991150493c836505`（第五轮 budget 锚点）
- 本轮实现 commit（按依赖顺序）：
  1. `2c63141` docs(openspec): Round 6 规范先行（proposal/design 3.8/spec 6 Requirement/tasks 12）
  2. `551e8a8` fix(treasury): reservation 持久 key 编码完整 typed owner identity（v3）+ 原子迁移
  3. `c748925` feat(treasury): durable quarantine——executing/faulted transaction 跨 tick 持久隔离
  4. `b32f1ee` feat(treasury): safe execute 结果语义重定义 + receipt corruption fail closed
  5. `f3055db` feat(treasury): 显式 fault resolution 协议替代无条件 clear fault
  6. `bd297ed` feat(treasury): prepared handle 生命周期有界化（WeakMap 全周期 + 有界 active registry）
  7. `6573b71` feat(treasury): canonicalization 前的 runtime input 形状验证（防 throw 最小集）
  8. `16190b8` feat(treasury): commitment completeness 补严 + authorizationSafe 多条件联合判定
- 最终实现 commit 与 budget 锚点 commit 见 git log（本文档随第 9 个提交入库）。

## 修改范围（关键文件）

- `src/runtime/treasury/quarantine.ts`（新建）：durable quarantine store
  （q: 前缀键、64 条上限 + overflowed、占用聚合只读查询）
- `src/runtime/treasury/faultResolution.ts`（新建）：显式 resolution 协议
  （resolve-as-committed / resolve-as-not-executed）
- `src/runtime/treasury/facade.ts`：tick 边界分类（prepared 释放 vs
  executing/faulted 隔离）、prepare 门禁（transaction_quarantined + 非法
  幂等分支收紧）、executePreparedAction 结果语义（executed_unsettled /
  executed_abort_failed / 抛错 abort 未确认隔离）、handle registry
  WeakMap+active 化、query authorizationSafe 联合判定 + blockers
- `src/runtime/treasury/types.ts`：reason 新增 transaction_quarantined/
  invalid_input；TreasurySafeExecuteResult 重定义；TreasuryBalanceView
  新增 authorizationBlockers；metrics 新增 preparedQuarantinedAtBoundary
- `src/runtime/treasury/receipts.ts`：commitSettledReceipt corrupted→fatal；
  peekTreasuryReceiptHealth；clearForTest 清理 quarantine
- `src/runtime/treasury/writeFault.ts`：移除无条件 clear；受控
  clearTreasuryWriteFaultMarkerForResolution（严格匹配）；phase 新增 abort_failed
- `src/runtime/treasury/commitments.ts`：status/blockedReason 枚举校验、
  resource ∈ RESOURCES_ALL、聚合安全整数检查、receiver 房间 completeness 修正
- `src/runtime/treasury/canonicalTransaction.ts`：validateTreasuryTransactionInputShape
- `src/runtime/treasury/ownerIdentity.ts`：treasuryReservationOwnerToken
- `src/runtime/resourceReservation.ts`：store key v3（ownerToken）+ 原子迁移
  + isReservationOwnerMigrationComplete
- `src/types/memory/runtime.d.ts`：resourceReservationsOwnerVersion 2|3、
  treasury.quarantine 声明（runtime 指纹同步 9e5e446c…）
- 测试：新增 treasuryQuarantine / treasuryFaultResolution 两个 suite；
  treasuryTypedOwnerMigration（v3 重写）/ treasurySafeExecute /
  treasuryWriteFault / treasuryPreparedHandle / treasuryWriteArchitecture /
  treasuryCommitmentCompleteness 扩展

## 新增不变量（本轮守护）

1. 相同 room+resource+id 不同 kind/namespace 的 owner 持久层永不碰撞（ownerToken）；
2. executing/faulted 的 transaction 在 tick 边界必进 durable quarantine，
   资源/容量/identity 持续占用（只有显式 resolution 解除）；
3. Game callback 成功后的任何 Treasury 故障均返回 executed_unsettled
   （retryForbidden），绝不暗示未执行；同 id 下次调用 callback 零调用；
4. write fault 只能经 resolution（transactionId+digest 严格匹配）解除；
   不存在无条件删除 marker 的入口；
5. receipt corrupted 三态保真：绝不 already_settled、绝不发布 heap projection；
6. active handle registry 有界（终态即删、tick 边界 stub 化）；
7. malformed runtime input 结构化拒绝（不 throw、零副作用、callback 零调用）；
8. 未知枚举/非法 resource/聚合溢出 → scope 或 global incomplete →
   authorizationSafe=false；
9. authorizationSafe 联合判定（commitment/receipt/fault/quarantine/
   lifecycle/migration），blockers 指示主因且不归零数值。

## 验证命令与真实结果

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| Treasury 聚焦测试 | `npx jest --config jest.config.cjs src/runtime/treasury/` | 16 suites / 276 tests 全过 |
| 全量 Jest | `npx jest --config jest.config.cjs` | **210 suites / 964 tests / 964 passed / 0 failed / 0 pending** |
| TypeScript typecheck | `npm run typecheck`（build + test 双工程） | 0 错误 |
| 正式 build | `npm run build`（rollup → dist/main.js） | 成功；sha256 `89f8128810f149ef242c025e202f83dd8fd849aaaf02f1ec4bb6d0ec3a511ec3` |
| Jest budget | `node scripts/verify-jest-budget.mjs`（锚点提交后执行） | 见下（锚点 commit 独立提交） |
| 生产 compat 引用检索 | `grep -rln 'from "@/runtime/treasury/compat"' src/ \| grep -v .test.ts` | 空（仅 treasury 测试引用） |
| 无条件 clear 检索 | `grep -rln 'clearTreasuryWriteFaultForRepair\s*(' src/` | 空（函数已移除，仅架构测试以调用形态守护不回归） |
| reservation 直写检索 | `grep -rlnE 'Memory\.runtime\.resourceReservations\[…\]=\|resourceReservations\s*=\s*\{' src/ --include=*.ts`（排除权威文件与测试） | 空（仅 resourceReservation.ts 权威 + 既有架构守卫通过） |
| faultResolution 生产引用检索 | `grep -rln faultResolution src/`（排除自身/测试） | 仅 3 处 JSDoc 注释提及，无 import |
| Memory 声明指纹 | `test/memoryDeclarationBoundaries.test.ts` | 通过（runtime 指纹更新为 `9e5e446c4fbd8dd22dcc83ed353dcaf254268ee0f555a9a7597f01cf7a2665d4`） |

预算：本轮新增 2 个 suite、51 个 test（208/913 → 210/964）；预算锚点以独立
commit 提交（`requiredBaselineCommit` 指向包含全部实现与测试的 `16190b8`），
锚点 commit 自身通过 `verify-jest-budget`。

## 边界声明

- 未部署到 Screeps（无 `npm run push`）；未接入任何真实 Game writer
  （ResourceControl/market/terminal/carrier/lab/factory 写路径零生产改动）；
- 未合并 main；无 force push；无 reset/rebase 已有历史；
- 所有验证为本地确定性测试（静态），**不代表线上验证**；write-fault
  修复工具仅为显式 resolution 协议（无自动修复/自动对账）。
