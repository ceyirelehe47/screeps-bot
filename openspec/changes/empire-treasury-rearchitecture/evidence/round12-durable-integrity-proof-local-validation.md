# Round 12 — Durable Integrity Proof & Stable Reconciler Identity 本地验证证据

日期：2026-08-31 · 分支：refactor/empire-treasury-rearchitecture · 全部为**本地验证**（仓库无 CI，不声称任何远端流水线背书）。

## 1. 基线与终态

- 起始 HEAD：`049feed20607551669a777cad61d9ae95875c9f7`（Round 11 终态；fetch 后确认与远端一致）
- 基线测试预算：223 suites / 1268 tests
- 验证后预算：224 suites / 1299 tests（`verify-jest-budget` PASSED）

## 2. Commit 列表（线性）

| commit | 作用 |
|---|---|
| `08010cd` | feat(treasury)：第十二轮全部协议实现（stable semantic identity、fault staged publication、tombstone/receipt attempt identity、digest 重算、structure union、forensic 隔离、production 类型边界） |
| `7ebd7d7` | test(treasury)：Round 12 测试（新增 31 用例）+ 既有 fixture 适配 + schema 指纹锚点 |
| （本提交） | docs(evidence) + chore(test-budget)：文档与预算锚点 |

说明：实现改动在多个文件间强耦合（facade intentContract 类型 ↔ actionContracts 调用、store 版本 ↔ 协议接线），为保证每个提交可独立通过 typecheck，实现以单提交落地；测试与锚点独立成提交。

## 3. 命令与结果

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（build + test 两个 tsconfig） | 通过（零错误） |
| `npx jest src/runtime/treasury` | 29+1 suites 全部通过（563 + 31 = 594 用例，含新增文件后 30 suites / 593+ 用例） |
| `npx jest`（全量） | 224 suites / 1299 tests 全部通过 |
| `npm run build`（rollup） | 通过（dist/main.js 产出，bundle sha256 39c60194…） |
| `node scripts/verify-jest-budget.mjs` | `JEST_TEST_BUDGET=PASSED`（suites 224 / tests 1299；requiredBaselineCommit=7ebd7d7） |

## 4. 目标完成情况

| 目标 | 状态 | 关键落点 |
|---|---|---|
| 3.1 fault publication | ✅ | authorizationLedger staged publication（结果不忽略、read-back、forensic marker、capacity admission：writeReadiness `authorization_fault_capacity_exhausted`） |
| 3.2 fault entry 完整身份 | ✅ | authorizationFaults v2（cohort facts/adapter 三元身份/postings/structure facts/durableIdentityDigest；identity_conflict；v1→legacyV1） |
| 3.3 tombstone attempt identity | ✅ | resolutionStore v3 + faultResolution 快路径 identity 比较 + recoverStagedResolutions 释放前校验 |
| 3.4 finalized proof | ✅ | receipts v4 settlement proof + recoveryCoordinator.checkTreasuryFinalizedProof 按 attempt identity |
| 3.5 stable semantic identity | ✅ | actionContracts `semanticIdentity`（必填）+ AC4/cohort/durable identity/capability 全链路绑定 |
| 3.6 digest 重算 | ✅ | identityProof.ts 单一 helper；load/写入前/read-back/转移/repair/签发/prevalidation 全覆盖 |
| 3.7 structure union | ✅ | canonicalization 唯一推导 + 矛盾声明拒绝 + 全判定点按 bindingKind |
| 3.8 forensic isolation | ✅ | quarantine `forensic` 标记 + 诊断 + capability/resolve 拒绝 |
| 3.9 fault store health | ✅ | RESOURCES_ALL/受控枚举/key 一致/entryCount/identity 重算/未知版本 fail closed |
| 3.10 类型边界与 facade 拆分 | ✅ | authorization 仅 opaque bundle；新逻辑位于 authorizationFaults/identityProof/resolutionAuthority/recoveryCoordinator/faultResolution，facade 仅接线 |

## 5. 关键不变量（新增）

见 design.md 3.14.1。要点：marker 无 authority 时必须是 forensic phase 且有显式解除通道；旧 proof（tombstone/receipt）不能解决同 ID 新 attempt（conflict/insufficient 均 fail closed）；digest 必须可由持久事实重算；global reset 后语义身份不一致不得解释；legacyV1 与 forensic 隔离可区分。

## 6. 行为变更说明（对既有测试语义的收紧）

- 携带已消费/伪造 capability 的重复 resolution 调用不再幂等返回 already_resolved（无法证明 attempt identity → 拒绝）；pre-execution 通道的解除后幂等须携带匹配 digest。
- 无 durable intent 的两阶段 prepare/commit commit-fault quarantine（Round ≤11 可经 capability 解除）按 3.8 进入 forensic 隔离——只能显式 forensic 流程处理。这是任务书 3.8 的明确要求（"intent 缺失时生成的最小 quarantine 不能被普通 reconciler 解释"）。
- 低层（非 contract）executePreparedAction 路径的 intent 现在从当前 registry 绑定 adapter 语义身份；若执行时该 kind 无注册 adapter 则 authority 缺少语义身份 → capability 隔离（不猜测）。

## 7. 遗留问题（阻断 terminal.send adapter / shadow 阶段的事项）

1. 两阶段 prepare/commit 路径（无 intent）的 commit fault 现为 forensic 隔离，尚无专门 forensic resolution 管理入口（人工修复通道）——接入真实 writer 前需要决定该路径是否全部迁移到 executePreparedAction/contract 协议。
2. forensic quarantine 的解除仍只有"显式人工修复/迁移"，没有自动化 forensic resolution 流程。
3. authorizationFaults v2 的 read-back 不一致分支为防御性代码（写入即读回同一 Memory 对象），当前测试覆盖 identity_conflict/store_fatal/capacity 路径，read-back 分支由实现保证。
4. 旧持久数据（Round ≤11 写入的 intent/quarantine）缺少 adapter 语义身份字段：load 兼容（可选字段），但 capability 签发会隔离——需要在接入真实 writer 前评估线上数据是否需要一次性显式迁移。

## 8. 部署状态

未部署、未合并 main、未调用任何真实 Game writer（八个生产 writer 文件零改动）。工作区干净（除本提交文件）。
