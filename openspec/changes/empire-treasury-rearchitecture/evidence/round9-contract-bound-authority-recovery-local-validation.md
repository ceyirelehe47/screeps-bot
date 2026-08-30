# Treasury Round 9 — Contract-Bound Authority & Recovery Closure 本地验证证据

> 验证日期：2026-08-31。分支 `refactor/empire-treasury-rearchitecture`。
> 本仓库无 GitHub CI——以下全部为**本地验证**（不得表述为 CI passed）。

## 1. 提交范围

- 起始 HEAD：`092677ab57589e1d3d929758a667e5f1574fa0cc`（Round 8 终点）
- 最终 HEAD：见第 12 节 commit 列表末项（本 evidence 与预算锚点提交前）
- commit 列表（按提交顺序）：

| commit | 主题 |
|---|---|
| `eb0ec5f` | docs(openspec): 定义 Round 9 不变量与任务（proposal/design 3.11/spec 11 Requirement/tasks 15.1-15.14） |
| `8f6656e` | refactor(treasury): 安全 canonical encoding + adapter version 绑定 + 完整结构 incarnation 验证（4.11/4.12） |
| `b8d7830` | refactor(treasury): contract-first authorization 与原子 bundle redemption（4.1/4.2） |
| `8436ce0` | refactor(treasury): 封闭 writer kernel——架构测试升级全量扫描（4.3） |
| `7c0e572` | refactor(treasury): intent 完整合同身份绑定与严格 phase 状态机（4.4/4.5） |
| `87a8b6f` | refactor(treasury): recovery 按 intent phase 事实等级分级恢复（4.6） |
| `bd172ba` | refactor(treasury): unified unresolved authority（4.7） |
| `3ea195b` | refactor(treasury): 私有 reconciliation capability（4.8） |
| `529feb2` | fix(treasury): staged receipt refresh recovery 修复与 resolving tombstone retention（4.9/4.10） |
| `9e9c240` | test(treasury): 第九轮 operation-count fixture |

## 2. 不变量 → 实现位置

| 不变量（任务书第四节） | 实现文件 |
|---|---|
| 4.1 contract-first authorization | `authorization.ts`（TreasuryContractAuthorizationOptions/Bundle、policyFingerprint 通道移除）、`facade.ts`（authorizeTreasuryActionContract/validateTreasuryAuthorizationForRedeem） |
| 4.2 原子 bundle redemption | `facade.ts`（TreasuryWriterKernelExecution/redeem 点）、`actionContracts.ts`（executeTreasuryActionContract 预验证→fresh 结构→原子消费） |
| 4.3 writer kernel 封闭 | `facade.ts`（@internal 标注）、`treasuryWriteArchitecture.test.ts`（全量扫描规则） |
| 4.4 intent 完整合同身份 | `intents.ts`（v2 字段）、`facade.ts`（executePreparedAction intentContract）、`runtime.d.ts` |
| 4.5 严格 phase 状态机 | `intents.ts`（transitionTreasuryIntentPhase）、`facade.ts`（read-back/not_found 处理/phase 写失败分支） |
| 4.6 recovery 事实等级 | `intents.ts`（recoverTreasuryIntentsAtTickBoundary 映射）、`writeFault.ts`（ok_pending_commit_unresolved） |
| 4.7 unified unresolved authority | `unresolvedAuthority.ts`（新模块）、`facade.ts`（签发）、`faultResolution.ts`（prevalidate） |
| 4.8 私有 capability | `reconciliation.ts`（纯类型）、`facade.ts`（闭包 registry/consumeReconciliationCapability）、`faultResolution.ts`（窄接口） |
| 4.9 staged receipt refresh recovery | `resolutionStore.ts`（recoverStagedResolutions 判定 receiptTick ≥ settledAtTick + 幂等续做） |
| 4.10 resolving retention | `resolutionStore.ts`（evict 只删 final；final not-executed 补释放 intent） |
| 4.11 canonical encoding | `canonicalEncoding.ts`（新模块）、`actionContracts.ts`（AC2 digest） |
| 4.12 结构 incarnation 验证 | `actionContracts.ts`（structureBindings 受控接口/fresh 必需/全结构重验） |

## 3. 协议要点（实现摘要）

### contract-first authorization 协议
`buildTreasuryActionContract`（canonicalize → adapter.validate(canonical) → derivePostings(canonical) → 受控 structureBindings 快照 → durableFacts → AC2 digest）→ `service.authorizeTreasuryActionContract(contract, options)`（contract 防伪/时效/version → write admission ready 前置 → 每资源授权需求从 canonical postings 派生（amount=Σ|负 delta|、rooms/locations=实际位置、contractDigest/adapterVersion 必填）→ 原子签发 bundle：任一资源失败回滚已签发 token 预算）。自由字符串 policyFingerprint 通道已移除——policy authority 只能是受控 withhold 数值（`wh:<n>`）。

### 原子 bundle redemption 顺序
```
contract 防伪/跨 tick/adapter kind+version
→ bundle/token 只读预验证（身份/generation/tick/revisions/transactionId/
   actionKind/digest/adapterVersion/重复/覆盖——零消费）
→ 结构 incarnation 重验（fresh observation 必需——配额耗尽拒绝，不降级 shared）
→ executePreparedAction(input, callback, execution):
     prepareTransaction（tentative 接管；拒绝=零消费零 callback）
     → redeemAuthorization()（一次性消费全部 token——预算→tentative 原子转移）
     → writeTreasuryIntentEntry(ready, 绑定完整合同身份)
     → read-back 验证（digest/contract/postings/phase）
     → transition ready→executing（任一 rejected 含 not_found = 零 callback）
     → adapter.execute 恰好一次
     → OK: transition→ok_pending_commit（失败=不普通 commit→executed_unsettled）
     → 非OK: transition→returned_non_ok（失败=不普通 abort→executed_abort_failed）
     → 抛错: execution_unknown + quarantine（emergency intent 保留）
```

### intent phase 状态机（合法迁移表）
`ready→executing`；`executing→{returned_non_ok|ok_pending_commit|execution_unknown|quarantined}`；`returned_non_ok→{execution_unknown|quarantined|resolution_pending|aborted}`；`ok_pending_commit→{execution_unknown|quarantined|resolution_pending|committed}`；`execution_unknown→{quarantined|resolution_pending}`；`quarantined→resolution_pending`。幂等仅限同 digest/contract 且已处目标 phase；`committed/aborted` 为终态。

### recovery phase 事实等级映射
| intent phase | 恢复动作 | quarantine phase | not-executed resolution |
|---|---|---|---|
| ready | 确认未执行释放 | — | — |
| returned_non_ok | 转 quarantine | action_returned_non_ok_abort_failed | 允许 |
| ok_pending_commit | 转 quarantine | ok_pending_commit_unresolved（commit 类） | **拒绝**（事实单调） |
| executing/execution_unknown/quarantined/resolution_pending | 转 quarantine | executing_at_end_tick | 允许 |
| committed/aborted | 终态残留幂等释放 | — | — |

### unified authority 规则
`resolveTreasuryUnresolvedAuthority(id)`：同 id 双存在时 digest/kind/postings（canonical 逐腿）必须全等否则 `authority_inconsistent` fail closed；一致取 quarantine（contract 事实从 intent 合并）；intent-only 完整参与签发与 resolution。release 幂等释放 quarantine+intent+匹配 marker。

### capability 边界
registry/consumed WeakSet 在 `createTreasuryService` 闭包——`reconciliation.ts` 只留类型（无 register/validate/consume 导出，架构测试扫描导出面）；resolve 签名 `(service, input)`——generation 由 service 闭包校验（调用者提交 serviceGeneration 的输入路径不存在）；capability 绑定 authorityKind/contractId+digest/adapterVersion/durablePayloadVersion/postFaultEpoch/reconciler kind+version。

### staged resolution 恢复流程
resolving committed：`receiptTick ≥ tombstone.settledAtTick` 才 finalize；否则幂等续做 refresh 至**原定** settledAtTick（不缩短 replay horizon）；refresh fatal → 保留 resolving + refreshBlocked（authority 不释放）。retention：只有 final 可清理；resolving 永不驱逐（满载 fail closed）；final not-executed 恢复补释放 quarantine+intent+marker。

### canonical encoding 约束
长度前缀文本（key 排序/数组保序/-0 与 0 区分）；拒绝 cyclic/accessor（getter 零副作用读取）/非普通 prototype/class/Date/Map/Set/function/symbol/bigint/undefined/NaN/±Infinity/稀疏数组/symbol 键；深度≤16/文本≤4096/数组≤256/键≤64；digest AC2 绑定 encoding version+kind+adapter version+transactionId+canonical args+canonical postings+结构快照。

### 结构 incarnation 验证
受控 `structureBindings(args)→{roomName, locationKind("storage"|"terminal"), label?}`（不再接受任意字符串 structureIds）；快照 = posting locations + 全部声明结构（声明房间不在管辖即拒绝）；执行前 fresh observation 必需（配额 8/tick，耗尽 `fresh_observation_unavailable` 拒绝）逐结构重验 structureId。

## 4. 新增/升级持久化状态与容量

| store | 版本 | 变更 | 容量/清理 |
|---|---|---|---|
| `Memory.runtime.treasury.intents` | 1→2 | entry 新增 optional contractDigest/adapterVersion/durablePayload(≤512)/durablePayloadVersion；v1 无损升级 | 上限 64 不变；恢复按事实等级转换/释放 |
| `Memory.runtime.treasury.resolutions` | 2（不变） | resolving 恢复语义升级（settledAtTick 判定）；evict 只删 final | 上限 256；**resolving 永不清理**（满载 fail closed）；final 按 retention 5000 |
| write-fault phase 枚举 | — | 新增 commit 类 `ok_pending_commit_unresolved` | marker 单条不变 |

heap-only 有界：authorization ledger ≤64 active（既有）、bundle = 其 token 集、capability registry WeakSet（单次使用+tick/generation 失效）、canonical args 编码 ≤4096、structureSnapshots ≤16 项。无随历史 transaction 无界增长的 heap strong Map。

## 5. 验证命令与真实结果（本地）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（0 error） |
| `npm run build` | 通过（bundle sha256 712b4ed6…，29.1s，无循环依赖警告） |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 25 suites / 473 tests 全部通过 |
| `npx jest --config jest.config.cjs` | **219 suites / 1181 tests 全部通过（0 failed 0 skipped）** |
| `node scripts/verify-jest-budget.mjs` | PASSED（预算锚点提交后；见第 6 节） |

### 测试规模对账
- Round 8 基线：217 suites / 1130 tests
- Round 9 新增：2 个 suite（treasuryCanonicalEncoding 11、treasuryContractAuthorization 14）；既有 suite 扩量：treasuryActionContract 12（重写）、treasuryAuthorization 19（适配）、treasuryDurableIntent 21→30、treasuryFaultResolution 25→36、treasuryWriteArchitecture 15→16、treasuryWriteAdmissionPerformance 12→14
- 最终：219 suites / 1181 tests（ suites +2、tests +51，零删除）

### operation-count 结果
- bundle 预验证/执行循环（单资源 1 token/2 postings ×3 + 多资源 2 token/3 postings ×3）：intent/quarantine fullScans = 0（与 token/posting 数线性）
- contract-first 授权 ×16 于 512 条既有 receipt 规模下：fullScans 增量 = 0
- 既有第八轮 fixture（authorize/prepare O(1)、intent admission O(1)、token 消费 O(1)）全部保持通过

## 6. 预算治理

- `monitor-data/apply-budget-treasury-round9.mjs`（新增）：读 `jest-file-counts.json` → 写 `test/test-suite-budget.json`（硬校验 219/1181；treasury 文件 tier=high-risk；baseline=参数 commit）
- `scripts/verify-jest-budget.mjs`：requiredBaselineCommit 指向含全部实现与测试的提交（预算锚点前一提交）；requiredTarget = 219 suites/1180+ tests；protected-full 15 文件不变
- .gitignore 白名单：monitor-data/apply-budget-treasury-round9.mjs
- 流程：先提交全部实现/测试/evidence → 独立预算提交（不 amend、不 rebase）

## 7. 架构封闭验证

- 全量扫描规则（第六轮固定列表废除）：任何 src 生产 .ts（treasury 协议栈白名单外）引用 `executePreparedAction`/`prepareTransaction`/`consumeTreasuryAuthorization`/`authorizeResourceUse`/contract 入口/单阶段入口/compat/故障注入器/repair 入口 → 测试失败；新增生产模块自动受约束
- capability 私有：`reconciliation.ts` 导出面封闭（无 registry/validate/consume 符号）；faultResolution 必须经 `service.consumeReconciliationCapability` 窄接口；其它模块访问 capability 内核 → 失败

## 8. 真实 writer 未接入确认

`git diff 092677a..HEAD --stat -- src/runtime/resourceControl.ts src/runtime/marketDirectContinuousAutomation.ts src/runtime/marketSaleProtection.ts src/runtime/marketSaleProtectionAdapter.ts src/runtime/factoryControl.ts src/runtime/synthesisControl.ts src/runtime/nukerControl.ts src/runtime/terminalActionEnergyOwnership.ts` → **空 diff**（零改动）。本轮未接任何真实 Game writer；未部署到 Screeps；未合并 main；未 force push。

## 9. 覆盖的 failure model

- tick 内 global reset（heap 丢失/Memory 完整）：intent 恢复按事实等级转换；resolving 恢复幂等（含 refresh 中断续做）
- 授权部分消费窗口：消除（预验证只读 + tentative 接管后一次消费）
- callback 后 phase 写失败：OK→executed_unsettled / 非OK→executed_abort_failed（durable fault，阻断自动重试）
- intent 写入/read-back/迁移失败：callback 零调用 + 保守关闭
- 双权威不一致：authority_inconsistent fail closed
- capability 伪造/跨 tick/跨 generation/重复使用/contract 不匹配：全部拒绝
- fresh 配额耗尽/结构替换：拒绝执行且零消费

## 10. 不能覆盖的（残余风险）

- **Screeps 硬 CPU 中断**（tick 中途进程终止、Memory 未 flush）：该 tick 全部 Memory 写入一并丢失，intent 与 Game 副作用可能同时消失——**不保证 exactly-once**（与 3.10.11 声明一致；recovery 按"无持久记录"处理）
- Memory 序列化边界外的持久化介质故障
- read-back 校验与 bundle 消费循环的后半失败（预验证后同步窗口内无 revision 变化源，理论不可达——防御层 + 计数，无法确定性黑盒注入）
- intent store v2 新字段的运行时真实数据迁移只覆盖 v1→v2 无损路径（无 v2 旧数据存在）
- slot 双 64 上限（quarantine/intent 各 64）的长期运营语义：满载 fail closed 的解除依赖显式 resolution 频率
- 所有协议验证仍是本地静态/确定性测试——**未做线上 shadow 或 live 验证**

## 11. 阶段判断

协议栈（授权→contract→intent→adapter→capability resolution）已闭环：授权只能绑定并执行同一个具体 contract；消费全有或全无；intent 状态机严格且事实单调；emergency intent 完整参与对账；capability 无公开绕过；staged 恢复无误 finalize 窗口。**可以进入"第一个真实 writer 的纯 shadow adapter 设计阶段"**——建议对象为 terminal.send（round-trip 观察清晰、单腿+费用腿结构已有测试 adapter 镜像），前置条件：真实 adapter 的 reconcile 实现（基于 post-observation 差异）与 shadow 期 observation 采样设计。

## 12. 声明

- GitHub 仓库无 CI：本文档全部为本地验证结果
- 未部署、未合并 main、未接真实 writer、未 force push
