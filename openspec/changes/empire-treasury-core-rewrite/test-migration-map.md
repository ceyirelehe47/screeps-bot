# Test Migration Map — Core Rewrite（II 修订）

> II 修订（2026-09-05）：在 I 轮映射之上新增 §6（Core Rewrite II 的行为级
> 映射：R01–R11 → B01–B28 → 具体测试/断言定位）。I 轮的保留/退役映射保持
> 为基线记录；II 轮对 I 轮 A 项中不等价的四项（A03/A16/A21/A22）按 R11
> 修正（见 §6 末尾）。


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

## 6. Core Rewrite II 行为级映射（R01–R11 → B01–B28 → 测试定位）

新文件：`src/runtime/treasury/treasuryRewrite2Acceptance.test.ts`（B01/B01'–B24/B28，42 tests）、`src/runtime/treasury/treasuryRewrite2Lifecycle.test.ts`（B03/B12/B13/B19/B25/B26，17 tests）、`scripts/baseline-red/pending-no-exit.baseline.ts`（R04 基线证明，显式运行）。

| 审查问题 | B 项 | 测试文件 › describe › it（断言观察量） | 基线红灯 |
| --- | --- | --- | --- |
| R01 真许可可变（dispatch） | B01 | Rewrite2Acceptance › B01 › "授权 500 后替换 permit.canonicalArgs…"（宿主 trace.amount === 500；对照用例执行一次 500） | ✅ 红 |
| R01 真许可可变（rearm） | B02 | Rewrite2Acceptance › B02 › "修改 rearm 的前代…"（second 未被消费、child 属 first）+ Lifecycle › B03 › "克隆真 dispatch 许可…"（WeakSet 身份） | ✅ 红 |
| 至多一次进入 | B03 | Lifecycle › B03 › 同 tick 重复 / execute 内重入 / 多 facade（真实调用恒 1） | 基线绿（回归保持） |
| R02 健康读回冒充成功 | B04/B05/B06 | Rewrite2Acceptance › B04（写丢弃→0 调用+pending）/ B05（另一份合法 memory、单字段回退→0 调用）/ B06（结果写丢弃→调用 1、不返回 committed、不回 pending、不可重复 dispatch） | ✅ 红 |
| R03 授权账目分裂 | B07/B08/B09/B10/B11 | Rewrite2Acceptance › B07（接收竞争同 tick/下一 tick）/ B08（他人预留 900 拒绝+own 对照）/ B09（pending 200+700 获准、committed 单次表达、观察刷新不双扣）/ B10（同键合计+对冲）/ B11（rearm 收紧 policy 拒绝） | ✅ 红 |
| R04 pending 无出口 | B12/B13 | Lifecycle › B12（64 项 sweep 全取消、调用 0、槽位恢复）/ B13（显式取消竞争、取消写失败重放、义务路径）；基线证明：scripts/baseline-red（基线 PASS=缺陷，修复后翻转 FAIL） | ✅（脚本）红 |
| R05 缺端口默认成功 | B14/B15 | Rewrite2Acceptance › B14（无端口接纳拒绝+已持久义务保留）/ B15（false/throw/幂等重试同一 key@attemptId） | ✅ 红 |
| R06 查询泄漏权威引用 | B22 | Rewrite2Acceptance › B22（health 无 memory 引用、ring 元素/counters 修改不回写） | ✅ 红 |
| R07 未受控结算入口 | B23/B24 | Rewrite2Acceptance › B23（自报字段不生效、unknown 不变）/ B24（still_uncertain/缺 adapter/抛错/语义变化对照） | ✅ 红 |
| R08 清理不公平 | B16/B17 | Rewrite2Acceptance › B16（前 8 永久失败、第 9 条 ≤12 tick 完成且前 8 duty 保留）/ B17（同 tick 端口调用 ≤8、重复 beginTick 不放大） | ✅ 红 |
| R09 单记录无完整体积上限 | B18/B19 | Rewrite2Acceptance › B18（1000 keys→unhealthy；端口可用时 20 keys 接纳拒绝且无半截记录）/ Lifecycle › B19（满载全字段最大值 ≤360,000、已接纳仍可收尾） | ✅ 红 |
| R10 历史环阻断核心 | B20/B21 | Rewrite2Acceptance › B20（ring 超限/重叠→degraded、恢复/收尾/写重建可用）/ B21（closing 无证据、发行不自洽仍 unhealthy 对照） | ✅ 红 |
| R11 验收覆盖不等价 | A03/A16/A21/A22 修正 | Acceptance › A03 新增"持真许可修改字段"（冻结抛错+原授权执行）；A16 新增"两笔各 60 容量 100 合计拒绝"；A21 扩为 health/ring/counters 全遍历；A22 改为两条真实 unknown 跨 reset 等价（完整 reset 由 B25 harness 承担） | — |
| 完整 reset | B25 | Lifecycle › B25（五断点：pending/已进入未写回/释放确认丢失/旧 rearm 回放/reconciler 跨 reset 与语义变化；宿主轨迹跨 reset 持续） | 新增（无基线 API） |
| 长期有界性 | B26 | Lifecycle › B26（1 unknown+300 完成+40 代链：active=1、ring ≤128、无第二历史 store）；Stress 扩展（接收竞争 62/200、sweep 500 项） | — |
| 负向变体自证 | B27 | 三变体（弱许可校验→克隆用例红；忽略 unknown 接收占用→B07 红；抛错当释放成功→B15 红）红灯后还原（evidence/negative-variant-*.log） | ✅ 红 |
| 元信息异常对照 | B28 | Rewrite2Acceptance › B28（frontier 溢出/legacy 阻断不擦除） | 基线绿（回归保持） |

数量对账（II 轮）：Treasury 16 suites / 327 tests（I 轮 15/306 + Rewrite2Acceptance 42 + Rewrite2Lifecycle 17 + acceptance 修正后 43；stress 6→8）。


## 7. Core Rewrite III（2026-09-05）：C01–C24 定位与旧 B 覆盖修正

### 7.1 新增套件

| 文件 | tests | 覆盖 |
| --- | --- | --- |
| treasuryRewrite3Acceptance.test.ts | 58 | C01–C13、C16–C22（授权累计/own-reservation 全链/fail-closed 一致/执行门禁/窗口/不双扣/独立发布/重入推进/结果写失败/多实例流出接收/端口重入预算/预扣失败零调用/公平有限界/ring 六类坏值/active 矛盾/有界值拒绝/逐槽预算推导与满载实测） |
| treasuryRewrite3Lifecycle.test.ts | 7 | C14/C15（同 tick fresh 不双扣、晚到 reconcile 保守、三断点完整 reset 账目重建、旧视图不超额、世界效果不被 reset 重置）+ C23（长期 unknown 混合流量） |
| scripts/baseline-red/treasury3-boundaries.baseline.ts | 17 | R1–R8 基线反例（13 缺陷 + 4 对照）；基线红灯 13/4 → 修复后治愈复验 17/17 |

### 7.2 旧 B 项覆盖修正（任务书 §10.3）

- B05（只改克隆）→ C08/C09（原地污染传入载荷 + 嵌套字段反转 + 换旧合法值 + 初始化失败 + 取消丢写）补齐"写边界污染"族。
- B03（同许可重放）→ C12/C13（不同合法 workKey 的两实例竞争）补齐"多实例账目"族。
- B15（释放确认写失败重试）→ III 预扣语义更新：预扣写失败的首个 tick **零端口调用**（原语义直接调用）；确认写失败后下 tick 同一幂等 (key, attemptId) 重试保留。
- B17（超限记录零调用）→ C16 补"记录健康且真实调用 >0 仍守限"的正向前提（超限输入 calls=0 只是输入校验，不作预算证据）。
- B20（ring degraded 标签）→ C19 补非数组 ring + 全命令路径 + 至少一笔合法工作真正完成收尾；degraded 查询返回空历史（不逐条快照坏值）。
- B12/B19（sweep/满载）→ 适配子预算 3/tick 与世界真实更新（观测量按 adapter 写世界后的数字断言）；B19 满载观测量放大以同时满足复验（占用极值物理可过）。
- 参考模型（treasuryKernelStress）→ 升级为世界真实更新语义（settled 推进时 worldA 扣减、settled 在推进前计入占用、世界每轮重建）——不再假设"删除记录即恢复容量"。

### 7.3 数量对账（III 后）

- Treasury：src 内 19 suites / 393 tests（328 适配保留 + 65 新增）。
- 全仓见 evidence/core-rewrite-iii/final/jest-full.json（budget manifest 为权威）。
