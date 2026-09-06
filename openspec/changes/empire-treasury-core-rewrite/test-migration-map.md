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

## 8. Core Rewrite IV（2026-09-06）：D01–D24 定位与旧 C 覆盖修正

### 8.1 新增套件

| 套件 | 用例数 | 覆盖 |
| --- | --- | --- |
| src/runtime/treasury/treasuryRewrite4Acceptance.test.ts | 20 | D01–D09、D12、D14、D20、D21、D22 |
| src/runtime/treasury/treasuryRewrite4Lifecycle.test.ts | 12 | D09–D11、D13、D15–D19、D23 |
| scripts/baseline-red/treasury4-boundaries.baseline.ts（不入默认收集） | 16 | R1–R7 基线反例（治愈复验版：8 反例全转绿 + 8 对照） |

### 8.2 D01–D24 → 测试定位

| D | 场景 | 测试 |
| --- | --- | --- |
| D01 | 观察不可确认不退出/恢复退出 | Acceptance "D01 committed 无消费者的观察责任"（2 例：范围缺失零写保留 + 恢复退出） |
| D02 | cleanup 后旧视图失效（1000/800/200） | Acceptance "D02 观察接管退出后的旧视图失效" |
| D03 | 接收空间责任闭合（100/80/20） | Acceptance "D03 接收空间的观察接管" |
| D04 | fresh 耗尽 + 结构变化 blocked/取消/对照 | Acceptance "D04 fresh 耗尽的执行门禁" |
| D05 | 组合（清理+旧视图+fresh 耗尽+多实例） | Acceptance "D05 组合场景" |
| D06 | 完整性三时点（authorize 前/真许可后/修复对照） | Acceptance "D06 完整性门禁三时点"（2 例） |
| D07 | rearm 门禁与权利保持 | Acceptance "D07 rearm 门禁与权利保持" |
| D08 | own-reservation 贯穿 + 他人责任 | Acceptance "D08 own-reservation 与他人责任并存" |
| D09 | heap 全清 + Memory 保留 → 接管 | Lifecycle "D09 全 heap reset 后的观察接管" |
| D10 | 无关推进不当覆盖 | Lifecycle "D10 无关推进与范围缺失" |
| D11 | 硬终止断点 + 晚到 reconcile executed | Lifecycle "D11 硬终止与晚到结论"（2 例） |
| D12 | 部分适用观察不判覆盖 | Acceptance "D12 多位置动作的部分观察" |
| D13 | 8 义务逐 tick 完成轨迹 | Lifecycle "D13 成对预算下的 8 义务完成" |
| D14 | 父子义务不重复继承 | Acceptance "D14 retry 链的义务继承" |
| D15 | 混合结果义务部分推进 | Lifecycle "D15 混合结果义务的部分推进" |
| D16 | 预扣/确认丢写 | Lifecycle "D16 预扣/确认丢写的预算语义"（2 例） |
| D17 | 重入共享预算 | Lifecycle "D17 重入与份额共享" |
| D18 | 断点 + 完整 reset | Lifecycle "D18 断点与完整 reset 后的预算/许可/义务" |
| D19 | 公平有限界（失败前置+噪声） | Lifecycle "D19 公平推进有限界" |
| D20 | retry_ready 矛盾 + 坏 ring 隔离 | Acceptance "D20 retry_ready 矛盾与坏 ring 隔离"（3 例） |
| D21 | 上界与实际表示逐项对照 | Acceptance "D21 空间上界与实际表示"（4 例） |
| D22 | 真实接纳满载生命周期预算 | Acceptance "D22 真实接纳满载与生命周期预算" |
| D23 | 混合规模模型 + reset | Lifecycle "D23 混合规模模型与账目一致" |
| D24 | 负向变体三件套 | evidence/core-rewrite-iv/negative-variants/（A:2 红 D01 / B:1 红 D04 / C:1 红 D13；还原后 425 全绿） |

### 8.3 旧 C 项修订（IV 语义演进，任务书 §9.4）

| 旧 C | 修订 | 依据 |
| --- | --- | --- |
| C01 第三例（同 tick B 80 拒绝） | 改为"同 tick 观察重建后 80 获准 + 850 物理余额拒绝" | IV/§4.2 视图时效：效果后旧观察立即失效、入口重建（转移保 scope 总量，80 本就可支配；防双花由 per-leg 物理余额保证） |
| C03 fixture | 直写 resourceReservations 改为 reserveProductionResourceForOwner（权威 key + revision/健康缓存失效） | IV/§5.2 授权路径消费 reservation 健康——直写 key 与 makeReservationStoreKey 不一致被正确暴露 |
| C05 | 不变（fresh 拦截保持） | — |
| C11 确认写失败 | 时序适配（成对预算下确认 0 份额） | IV/§6.1 |
| C12 | 世界序持久域（断言不变，比较域改变） | IV/§4.3 |
| C16"恰好 8 次" | 单 tick 端口调用 8 → 4（成对单位 2 份）；保留真实调用 >0、≤8、全实例共享、remaining 清空/工作退出双断言 | IV/§6.1（任务书 §9.4 明示 C16 非不可变业务要求） |
| C18 sticky-8 | 推进预算适配（成对语义） | IV/§6.1 |
| C15/B25 reset | harness 清 Treasury global（世界序已持久化于 Memory，槽退役） | IV/§9.3 |
| A20/B19 | fixture 腿数 16→12、generation/adapterVersion ≤9999；A20 invocation.atTick 取上一 tick | IV/R6 validator 收紧 + tick 兜底严格大于 |

### 8.4 数量对账（IV 后）

220/1228 → **222 suites / 1260 tests**（+2 套件 = treasuryRewrite4Acceptance/Lifecycle；+32 测试）。全仓零回归；budget manifest 与锚点同步更新（evidence/core-rewrite-iv/final/）。

## Core Rewrite IV · Remediation I（2026-09-06）

### E01–E20 → 实际文件/测试映射

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| E01 | treasuryRewrite4Lifecycle.test.ts（D11 改造·"调用边界已发布、adapter 尚未进入"） | 真实 adapter execute 入口快照：phase=dispatching、boundary 非空、invocation/external null、不重发 |
| E02 | treasuryRemediationIService.test.ts（"E01 快照 reset 后无证据保留 unknown…"） | 无证据保留 unknown；exact not_executed 对账后 retry_ready |
| E03 | treasuryRewrite4Lifecycle.test.ts（D11 改造·"实际动作后、结果未写…"） | 效果后快照 + 晚到 reconcile executed → 观察接管退出、总调用 1、世界保留 |
| E04 | treasuryRemediationIService.test.ts（两用例） | dispatch_result 写失败→persist_failed+dispatching（不回 pending）+下 tick 恢复 unknown；committed 观察暂缺保留、源恢复关闭、真实余额授权 |
| E05 | treasuryRemediationIKernel.test.ts（两用例） | 发布丢写→调用 0 保持 pending+合法对照调用 1 收尾；原地污染→读回确认拒绝+独立 expected 不受污染 |
| E06 | treasuryRemediationIKernel.test.ts（"每 tick JSON 重载：后 4…"） | 前 4 永久 false：逐 tick JSON 重载、后 4 ≤3 tick 服务并移除、前 4 保留、无重复调用 |
| E07 | 同文件（"E07 前 4 随后恢复…" + 三变体） | 失败项恢复后仍可服务；1 义务/全 false/全 true 变体与游标回绕 |
| E08 | 同文件（三用例） | 预扣丢写调用 0；端口 throw 份额不退义务保留；释放成功确认丢写同 (key,attemptId) 幂等重试 |
| E09 | 同文件（"端口回调内重入…"） | 重入共享预算 ≤8、成对单位 ≤4、旧游标不覆盖内层、可完成义务有限推进 |
| E10 | 同文件（"每 tick 完整 JSON 重载：后方工作…"） | 前 8 失败工作+后方 8 义务+混合流量，逐 tick JSON 重载，推导界 40 内真完成、失败风险保留 |
| E11 | treasuryRemediationIService.test.ts（"非空 child externalConsumers…"） | 明确拒绝+理由含"不支持"；frontier/active/父代不变；无 child 无调用；capability 随后合法可用 |
| E12 | 同文件（"非法类型新义务…"） | null/对象/字符串结构化拒绝；同一 capability 合法请求新 ID 执行；child 不继承义务 |
| E13 | 同文件（"克隆许可提交次数…"） | 克隆 >fresh 上限：fresh/freshEpochLimitRejections/policy 计数零增量、动作 0、持久状态不变；真许可随后 committed |
| E14 | 同文件（"过期/旧 runtime/已消费…"） | 过期/已退出工作/已消费/伪造输入全部高成本复验前拒绝（fresh 零增量） |
| E15 | 同文件（"合法许可 + policy 收紧…"） | 窗口关闭/真实 fresh 耗尽 observation_unavailable 阻断；条件恢复对照可执行 |
| E16 | 同文件（"旧 runtime 继续变更后 reset 用指定快照…"） | 指定快照严格使用；Memory/active 嵌套引用脱离；旧引用毒字段不污染 |
| E17 | 同文件（"committed 接管退出…"） | 全清后 committed 接管退出、unknown 不重发、引用隔离、余额不双扣（contract 用新模块句柄构建） |
| E18 | 同文件（"完成/真实 rearm/长期 unknown…"） | child 实际调用、世界账目一致、ring 旧 ID 不授执行权、旧视图不超额授权 |
| E19 | treasuryRemediationIKernel.test.ts（"worst 构造器…"） | 新字段极值过 validator；满 64/128 构造 343,817 ≤360,000（bytes=chars）；已接纳收尾余量 |
| E20 | evidence/core-rewrite-iv-remediation-i/negative-variants/（五变体 patch+红日志+还原绿日志） | 不前置边界/记录内从头/忽略 rearm 义务/认证不前置/reset 跳过 JSON 安装——各自语义红灯后还原全绿 |

### D09/D11/D19/D23 语义纠正（V1–V3）

- **D09（V2）**：此前 `snapshotWholeMemory()` 的结果被弃用（`void snapshot`）且 helper 允许沿用原 Memory——引用隔离不成立。helper 契约修复后无条件 JSON 重载；D09 行为不变（入口快照等价重载），E16/E17 补引用隔离断言。
- **D11（V1）**：此前 dispatching fixture 为手工填充（phase/external 手填，非真实路径产物）。改为真实 adapter 断点捕获（execute 入口/效果后快照）+ 指定快照 reset。
- **D19（V3）**：名称声称"公平推进有限界"但同 kernel 连续 tick、无逐 tick 重载。改造为每 tick 用上一 tick 真实序列化快照重建运行时；同记录 8 义务前缀失败场景补于 E06。
- **D23（V3）**：RETRIED 分支此前只是 non-ok 父代（无真实 rearm）。改造为 60 对完整 retry 链（capability→executeRearm→child 实际执行）+ 旧父代许可回放拒绝。


## 9. Core Rewrite IV · Remediation II：F01–F20 映射与 E 矩阵纠正（2026-09-06）

### 9.1 E 矩阵验证缺口纠正（V1/V2/V3）

| 旧项 | 缺口 | 纠正后形态 |
| --- | --- | --- |
| E02 | 效果前 Memory 配 reset 入口的效果后世界 + 固定 not-executed reconciler 冒充 exact | 重写为配对断点两分支：效果前分支（断点世界 1000、哨兵硬停于 adapter 入口→oracle not_executed）与效果后分支（世界 900、事件含 world-effect→oracle executed→观察接管退出）；reconcile 结论从宿主事件/分支世界序推导 |
| E06/E10 的 reloadKernel | JSON 往返后调用旧模块函数/ports——模块注册表未重建，非完整 reset | 公平循环改 performTreasuryKernelFullReset（每 tick 新 Memory 引用+新模块注册表+新 kernel；F16 混合流量同形态）；原形态降级 jsonRoundtripKernel 序列化探针（E06 独立用例；F14(b) 断言其旧许可仍 valid——即它不是完整 reset 的识别锚） |
| E08/E04 内联拦截器 | 卸载恢复旧 descriptor.value——回滚拦截期间放行的预扣 | 换共享 interceptTreasuryCoreWrites（test/mock/treasuryStorageInterceptor）：卸载安装拦截期间实际最终 liveValue；E08 确认丢写用例改双义务（cursor 1 可证）并断言捕获载荷同次含预算+位置 |

### 9.2 F01–F20 → 真实路径/断言定位

| F | 场景 | 文件 / describe / it（断言核心） |
| --- | --- | --- |
| F01 | 流出 800 覆盖不双扣 | treasuryRemediationIIService › F01/F02 › F01 流出（200 admitted/201 rejected/A 仍 closing/invocation 空）；基线 R1 流出同锚 |
| F02 | 流入 80 覆盖不双扣 | 同上 › F02 流入（空位 20 可纳/21 拒） |
| F03 | unknown/旧观察/不可用/最终退出 | 同上 › F03（unknown 200 拒；occupancy 单元锚点链对照含 external tick 兜底/无锚点保守/unknown 不释放；覆盖后退出额度恢复 200/201） |
| F04 | 同次发布丢写/篡改/合法对照 | treasuryRemediationIIKernel › F04（丢写调用 0 游标 0 预算 0；cursor 单字段篡改被独立 expected 拒绝；合法对照 4 份额完成） |
| F05 | 两硬断点快照 | 同上 › F05（onAllow 钩子内捕获：断点处端口调用 0、同 Memory 内预算 2+cursor 1+remaining 全；端口入口快照同证+正常收尾） |
| F06 | 断点恢复轮转+重复切点 | 同上 › F06（恢复续 1/2/3 不再调 f0→cursor 4；第 2 单位切点续 2/3；sticky 保留 closing） |
| F07 | 确认丢写+同 tick reset+幂等 | 同上 › F07（份额/位置保留；同 tick 从位置 1 续；a 恰 2 次 b 1 次全同 attemptId） |
| F08 | 重入/缩小回绕/混合 | 同上 › F08（重入后 cursor ≥4 不回退、每 key 恰一次；8 义务两 tick 回绕完成；false/throw/true 混合每 tick ≤4） |
| F09 | 非健康 preflight+facade 零增量 | treasuryRemediationIIService › F09/F10 › F09（三态×两许可 preflight 拒绝由基线 R3 承担；facade 路径 fresh/policy/trace/frontier/active 增量 0） |
| F10 | 健康对照/仅坏 ring/克隆 | 同上 › F10（坏 ring 仍 committed+fresh+1；克隆许可零 fresh） |
| F11 | 三断点分支+错关联 | 同上 › F11/F11（调用前 800 可纳 801 拒；错关联→still_uncertain 状态保留 unknown）；效果前分支见 E02 效果前 |
| F12 | 效果后结果未写无人工 external | 同上 › F12（效果后哨兵抛错→旧栈 catch 写 unknown 与恢复分支 invocation=null 隔离；executed→700/701→退出；调用/效果各恰 1） |
| F13 | 拦截器卸载契约 | 同上 › F13（卸载前后 Memory 全等；budgetUsed 2/cursor 不回退；同 tick reset 无凭空额度；正常写后有限完成） |
| F14 | 完整 reset 识别 | treasuryRemediationIIKernel › F14（旧许可 invalid+旧对象污染无效+新 registry 正常签发；jsonRoundtrip 探针旧许可仍 valid=非完整 reset 的识别锚） |
| F15 | 早期断点/消失结构/配对错误 | treasuryRemediationIIService › F15（恢复分支世界 1000 不含旧栈后来效果+事件可见集截断；消失 terminal 不复活+构建期拒绝；伪造断点 toThrow 断点配对不一致） |
| F16 | 混合流量逐 tick 完整 reset | treasuryRemediationIKernel › E10（V2 改造形态：8 失败工作+8 义务 good+过期 retry+噪声，逐 tick performTreasuryKernelFullReset，界 40 tick，失败义务保留） |
| F17 | 混合负载独立宿主账目 | treasuryRemediationIIService › F17（完成/真实 rearm/长期 unknown/部分清理/reset/旧视图；hostLedger 独立核算世界 850；unknown 占用→750/751） |
| F18 | 最坏值+越界拒绝 | treasuryRemediationIIKernel › F18（满 64/128 ≤360,000+bytes 另报；真实路径演化有界；cursor -1/1.5/越界 → unhealthy） |
| F19 | 全仓最终验证 | 无独立测试：typecheck/build/Treasury 定向（24 套件 482 tests）/Defense 冻结回归（11/118）/test/baseline（2 套件 11 tests）独立归类/budget 校验——证据见 evidence/core-rewrite-iv-remediation-ii/final/（含 10,000 完成/1,000 retry 既有压力套件在全仓 JSON 内的计数） |
| F20 | 负向变体 | evidence/core-rewrite-iv-remediation-ii/negative-variants/（nv1 旧 occupancy 语义→基线 R1+F01 红；nv2 游标移回回调后→基线 R2+F05 红；nv3 preflight healthy-only→基线 R3×3+F09 红；各自还原后全绿）；工具契约负向（错配断点/假 reset/旧 descriptor）由 F15/F14/F13 内联承担 |

### 9.3 基线反例持续回归

test/baseline/treasuryRemediationIIBaseline.test.ts（6 用例）：R1 流出/流入（200/20 admitted+201/21 rejected+A 保留）、R2（真预扣后确认前快照内 cursor=1+remaining 不变）、R3 三态（两 preflight invalid+reason 非空）。首跑 0f5965e 6/6 红（evidence baseline/），修复后全绿。


## 10. Core Rewrite IV · Remediation III：G01–G20 定位与旧 F/E 覆盖修正（2026-09-06）

| 编号 | 入口（文件/describe/it） | 断言定位要点 |
| --- | --- | --- |
| G01 | treasuryRemediationIIIKernel "G01 两义务同 kernel 重入" | 重入内层零 stats；D0/D1 各一次（toEqual 全序列）；retry_ready；remaining 空；budgetUsed=4。合法对照（D0=false）同 describe 第二 it |
| G02 | 同上 "G02 一个调度所有者" | 另一实例重入零推进；嵌套 endTick 关窗写入生效（lastEndTick）；释放 ≤4；顺序调用预算不回退 |
| G03 | 同上 "G03 端口返回值矩阵" | 13 种错误返回值逐 tick 全注入（单 tick 只触达前 4——矩阵必须全覆盖）均不释放；getter/then 不执行；恢复 true 全部完成；throw 单独 it |
| G04 | 同上 "G04 集合演化" | 1/2/3/8 义务部分成功：已确认不再调用、失败保留、下一待服务成员正确（consumerKeys[cursor%len] 语义断言） |
| G05 | 同上 "G05 预扣发布" | 丢写调用 0；单字段篡改（记录内 cursor——单义务集合取模恒 0 无差异，须两义务）独立 expected 拒绝；合法对照推进 |
| G06 | 同上 "G06 确认丢写" | true 后确认丢写：份额/位置不退款、同 attempt 幂等重试（a×2/b×1）、其他项不重复出现 |
| G07 | 同上 "G07 硬断点" | 预扣后调用前（callsAtBreakpoint=0——F05 模式）；端口后确认前（确认写断点）；恢复分支各成员恰一次 |
| G08 | 同上 "G08 失败前置" | 同记录前 4 false 后 4 true ≤3 推进 tick；跨记录失败前置 + 逐 tick 完整 reset 有限完成；端口恢复后收尾 |
| G09 | treasuryRemediationIIIService "G09" | B0（效果前）恢复：世界 1000/事件空/not_executed；无正面未执行事实（世界序越过）→ settle 仍 still_uncertain 拒绝 |
| G10 | 同上 "G10" | B1 对照 committed；两次独立恢复 B0 互不污染、C 效果不倒记 |
| G11 | 同上 "G11 分支链" | B2=B0 祖先+子分支 C、不含旧主分支 A 效果；错配事件源 throw（断点配对不一致） |
| G12 | 同上 "G12 同参数 A/B" | 只执行 A：entered/effect 仅归 A、B 空、余额 900；B 仍可独立执行（合法同参数不禁用） |
| G13 | 同上 "G13 逆序" | B→A 逆序及依次：各自恰一次、事件身份稳定 |
| G14 | 同上 "G14 上下文隔离" | 无作用域不归属（unlinked）；参数不匹配不归属；嵌套内外分离；异常不泄漏；reset 后新模块无旧上下文 |
| G15 | 同上 "G15 rearm" | 真实 capability→child 新 ID 执行；父代 entered 与 child effect 分离；旧许可重放拒绝；世界只流出 child 一笔 |
| G16 | 同上 "G16 对照" | 无责任时 1001 拒/800 纳（先拒后纳防占用污染）；流出 800 后 200/201；流入 80 后 20/21；A closing 未提前删 |
| G17 | 同上 "G17 门禁回归" | unknown 保守占用（800/801）；非健康授权拒；endTick 关窗后新授权拒 |
| G18 | treasuryRemediationIIIKernel "G18" | 64 active/128 ring/charBudget ≤360,000；份额 ≤8、释放 ≤4；全 false 义务保留 |
| G19 | 最终验证流程（evidence/core-rewrite-iv-remediation-iii/final） | 全仓收集无 skip/todo、目录内外数字分开、与固定验证 HEAD 一致 |
| G20 | evidence/.../negative-variants | R1 guard 失效/R2 truthy 回归/V1 不 reopen/V2 忽略参数核对——各自行为红（exit 1）+还原绿 |

### 10.1 旧 F/E 测试修订说明

- F06"重复切点"：逐项确认下写序列 = 预扣1、确认1、预扣2…；第 2 次放行写
  = 单位 1（f0，sticky 失败）的确认写。断言改为：份额 2、f0 保留、cursor
  停在 1、恢复续 f1/f2/f3（不从旧前缀重启）、失败义务保留 closing。
- F08"重入"：内层重入被 guard 结构化拒绝（不再有"内层已发布位置"）；
  cursor 断言改为下一待服务成员语义。F08"集合缩小回绕"：cursor 数值断言
  （==4）改为下一待服务成员（w4——旧数值 4 在 [w4..w7] 中指向 w7、跳过
  w4）。任务书 §7.4：不为保旧数字保留错误的数组索引含义。
- F04/F05/F07/E04/E02/D19 等保留原有安全要求，数字按新语义修订；
  treasuryRemediationIIService/IService 的 registerAttempt/recordCut/
  startBranch 调用点全部迁移到 runWithInvocation/captureBranch（harness
  reopen 消费）。
