# Test Migration Map — Core Rewrite I

旧 Treasury 测试（基线 cf2ee7b：81 suites / 1,624 tests）→ 新生命周期测试。全仓基线 283/2462 → 本轮实测 216/1099（Treasury 相关 15 suites / 266 tests；测试数量合理下降，每个被移除行为有对应新测试或明确"不再适用"理由）。

## 1. 保留（适配后原样存活）— 10 suites / 182 tests

| 旧文件 | 旧 tests | 新 tests | 适配说明 |
| --- | --- | --- | --- |
| treasuryCore.test.ts | 38 | 22 | 保留 observation 物理事实(5)/带上下文查询(2)/fail-closed 规范化(3+3)/owner-aware(5)/typed owner(3)/RuntimeServices(1，重写为挂载冒烟)。退役：单阶段 compat 登记/两阶段 prepare-commit-abort(10)/receiver 投影(2)——旧投影协议专属 |
| treasuryCanonicalEncoding.test.ts | 18 | 18 | 模块保留，零改动 |
| treasuryTransactionIdVectors.test.ts | 30 | 30 | 模块保留，零改动 |
| treasuryTypedOwnerMigration.test.ts | 41 | 41 | persistence clear → resetTreasuryCoreStoreForTest |
| treasuryCommitments.test.ts | 14 | 14 | compat 登记用例改为直接注入 capacityDelta（语义：索引的投影口径参数化） |
| treasuryCommitmentCompleteness.test.ts | 19 | 19 | write-fault/quarantine/receipt 注入 → treasuryCore unhealthy/incompatible/legacy 注入（等价阻断语义） |
| treasuryShadow.test.ts | 6 | 6 | 零改动（查询侧兼容） |
| treasuryImmutableRegistries.test.ts | 18 | 15 | bundle 执行用例 → 新 admit+dispatch 流；policy 失效用例 → 接纳路径 reasonCode 断言；reconcile 结论 → settleUnknownOutcome；退役 3 个纯 bundle 签发细节用例 |
| treasuryCapacityViews.test.ts | 4 | 4 | quarantine/intent 注入 → kernel active 记录注入 |
| treasuryActionContract.test.ts | 24 | 13 | 保留构建/派生/digest/structure binding/descriptor；退役 contract 执行 describe(12)、durable intent 迁移(2)——执行协议与 intent store 专属 |
| treasuryLifecycle.test.ts | 42 | 0（退役） | 见 §3（生命周期语义由新 kernel 测试族覆盖） |

## 2. 新增 — 5 suites / 84 tests

| 新文件 | tests | 覆盖 |
| --- | --- | --- |
| treasuryKernel.test.ts | 28 | 计量器自证(§9.1：正常/non-ok/throw 各一、两次计二、前置拒绝为零)；admit→dispatch→settle→cleanup→rearm→close 全阶段；排他/容量/满载；tick 保守恢复；unknown 占用保持；retry 全矩阵；ring 不授权 |
| treasuryKernelAcceptance.test.ts | 41 | A01-A24 全验收矩阵（R1-R5 等价：A04 恢复不消费、A05 absent/unhealthy/incompatible/legacy 四态、A06/A07 结构矛盾 fail closed 与顺序无关、A09 重入+多实例至多一次、A22 reset 等价） |
| treasuryKernelStress.test.ts | 6 | 10,000 完成生命周期（副作用恰 10,000、终态 <32KB）；1,000 代 retry 链；固定 unknown 混合负载 5,000；满载最坏记录体积；2 槽/2 资源独立参考模型（30 轮随机事件序列判定一致） |
| treasuryKernelArchitecture.test.ts | 7 | 单一写入口/旧模块不复活/真实 writer 禁用/testHarness 边界/treasuryCore 键权威/命令集封闭 |
| test/treasuryCommitmentInvalidationBoundaries.test.ts | 2 | 保留 revision bump 守护；退役 receipt/projection O(1) 源扫描 describe（实现专属，新等价由 kernel 占用 O(active) 与参考模型覆盖） |

## 3. 退役 — 71 suites / 1,358 tests（按语义分组）

| 旧组 | suites/tests | 不再适用理由 / 等价新覆盖 |
| --- | --- | --- |
| Round 12-21 轮次套件（proof/certificate/lineage/GRA/summary/receipt 迁移） | 40+/~1,100 | 锁定已删除的多 store 证明协议（GRA 矩阵/summary 重演/certificate 覆盖/retirement 三阶段/低层 provenance）。等价安全语义由 A02（frontier/洞）、A07（相反结论阻断）、A14/A15（rearm 边界）、A18（ring 不授权）覆盖 |
| Round 22 主系列 + Remediation I-XII | 27/~700 | journal 真持久化/marker discharge/staged commit/ticket gate/handoff/namespace 容量/opening-bound verifier 等全部为已删除协议的实现断言。R1→A04、R2→A05、R3→A06、R4→A07、R5→计量器自证+A 矩阵全部真计数 |
| treasuryWriteArchitecture / treasuryMemoryLifecycleContract | 2/70 | 旧架构边界（kernel channel symbol/低层原语/memory lifecycle 契约）→ treasuryKernelArchitecture 7 项新边界 |
| treasuryProjection / treasuryDurableIntent / treasuryQuarantine* / treasuryAuthorization* / treasuryContractAuthorization / treasurySafeExecute / treasuryPreparedHandle / treasuryTentativeLedger / treasuryWriteFault / treasuryWriteReadiness / treasuryWriteAdmissionPerformance / treasuryReservationActivation / treasuryLegacyIsolation / treasuryFaultResolution / treasuryDurableIdentity / treasurySemanticMatrix | ~14/~250 | 全部为已删除写协议（prepare/commit/abort/token/quarantine/intent/fault）的实现断言。等价：dispatch 恰一次(A09/A10)、tentative 防超卖(A16)、写后读回与 unhealthy(A05)、故障保守化(A12/kernel 测试) |
| treasuryLifecycle.test.ts（42） | 1/42 | 旧 beginTick/endTick 的 epoch 注册表/对账/作废语义。新 beginTick/endTick 行为由 kernel 测试恢复组 + facade 生命周期冒烟覆盖；decision epoch 机制随单阶段登记退役 |

## 4. 数量对账

- 旧 Treasury（src/runtime/treasury）：81 suites / 1,624 tests。
- 新 Treasury：src 内 14 suites / 264 tests（182 保留适配 + 82 新增）+ test/treasuryCommitmentInvalidationBoundaries 2 = 相关 15 suites / 266 tests。
- 全仓：283/2462 → 216/1099（预算 manifest 逐文件数字为权威；退役映射按语义分组如上）。
- 每个移除行为：等价新测试（A 矩阵/kernel/架构）或上表明确的"不再适用"理由（锁定被退役机制）。

## 5. 非 Treasury 冻结回归

- Defense 冻结清单 11 文件 / 118 tests：全部通过，生产文件零改动。
- `test/memoryDeclarationBoundaries.test.ts`：6/6 通过（runtime.d.ts treasuryCore 替换后指纹更新——必要兼容修复）。
- `test/treasuryCommitmentInvalidationBoundaries.test.ts`：2/2 通过。
