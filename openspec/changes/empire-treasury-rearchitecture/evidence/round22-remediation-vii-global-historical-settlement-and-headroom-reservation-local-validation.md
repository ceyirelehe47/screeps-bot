# Round 22 Remediation VII — Global Historical Settlement & Headroom Reservation（本地验证 evidence）

- 日期：2026-09-04
- 分支：`refactor/empire-treasury-rearchitecture`
- 预期起始 HEAD：`e8969aa0400bec5e853f5692bf87b42b21a52993`；实际起始 HEAD：`e8969aa0400bec5e853f5692bf87b42b21a52993`（一致——远端无前移）
- 最终代码/测试验证 HEAD：`c5864f5`（test(defense) 提交——完整验证在此 HEAD 执行；其后的 OpenSpec/evidence/budget 提交不含生产代码、测试代码或类型代码）
- 验证环境：本地 Windows（无独立 CI——全部为本地执行结果）

## 提交清单（本轮 Treasury）

| commit | 职责 |
| --- | --- |
| `fix(treasury): integrate historical settlement into global authority`（`f30c7ae`） | historicalSettlementAuthority 单一 resolver、attemptIssuer（ti1_ + 持久 high-watermark）、chainRetirementCertificate 数据源模块、prepare replay gate / opposite proof matrix / rearm preflight / child occupancy / reconciliation / current settlement 六处接线、existing historical record 删除前完整 revalidation（修复三） |
| `fix(treasury): reserve cleanup headroom before execution`（`4d49636`） | completionHeadroomReservation 持久独占 reservation store、prepare acquire、execute final admission 前移（Intent 写入/capability 消费/child_active/callback 之前）、释放/消费/TTL sweep、ensureHeadroom 与 readiness 计入 reserved |
| `fix(treasury): bound permanent replay history and isolate profiles`（`8a6d446`） | chain 压缩（certificate 一条覆盖全链 + per-attempt historical 退休）、retired range（相邻单调合并）、满载压缩活性、forensic proofClass（不再折叠 legacy）、automatic archive profile gate、activate 先 archive、actionContracts ti1_ 防伪、架构守护 |
| `test(treasury): cover remediation vii authority and reservation windows`（`18fc95e`） | treasuryRound22RemediationVII.test.ts（42 tests，T1–T19；T20 架构守护在 treasuryWriteArchitecture.test.ts）+ compaction 顺序修复（chain 压缩移到 completion archive 之后——T17 行为测试暴露的顺序缺口） |

## 全局 settlement authority 接线图（单一 resolver）

`historicalSettlementAuthority.resolveTreasuryDurableSettlementAuthority` 是唯一入口（live cleanup completion → durable historical completion → chain retirement certificate → generation-addressable tr1_ 代查询 → retired range；五态 exact/retired/conflict/absent/store_unhealthy）：

| 接线点 | 行为 |
| --- | --- |
| `facade.prepareTransaction`（lineage/summary 门禁之后） | exact committed → already_settled；exact not-executed → rearm_required；retired → retired_attempt；conflict → proof_conflict；unhealthy → completion_store_unhealthy（Receipt/Tombstone GC 后同 ID 不得再次进入 Game callback） |
| `oppositeProofMatrix`（双方向） | 相反 outcome 的 matching 权威 → exact_match blocker；同 ID 身份冲突 → identity_conflict；unhealthy → store_unhealthy（GRA/tombstone GC 后矩阵不失效） |
| `attemptOccupancy.preflightTreasuryRearmCapability` | historical committed 与 rearm-ready lineage 同 ID 共存 → proof_conflict（零 capability 零 mutation）；historical unhealthy → 零 capability |
| `attemptOccupancy.checkTreasuryChildAttemptOccupancy` | historical 权威中的 child ID → occupied；unhealthy → 按 occupied 阻断 |
| `facade.issueTreasuryReconciliationCapability` | 相反结论零签发、matching outcome 幂等 already_resolved、retired 隔离、unhealthy fail closed |
| `currentSettlementCoordinator`（verify + oppositeProofAbsence） | historical 进入事实源（相反结论 proof / 身份冲突 / unhealthy） |
| `resolutionCleanupCoordinator` + `cleanupStageAcknowledgement`（journal-absent 完成判定） | resolver 承载（chain 压缩后由 certificate 承载完成——不退化为 no_cleanup_authority） |

## permanent anti-reuse 设计（两层历史语义）

- **issuer watermark**（`Memory.runtime.treasury.attemptIssuer`，version 1）：`mintTreasuryInitialAttemptId` 签发 `ti1_<seq>_<hash16>`；seq 来自持久单调 high-watermark（mint → 写回 → read-back 相等确认）；global reset 后不回退不复用。caller 业务键只作为 correlation metadata 参与 hash lane。
- **bounded exact outcome authority**（historical store 384）：活跃 chain、近期审计与冲突检测保留 exact outcome；最近 `TREASURY_HISTORICAL_RETAINED_RECENT = 64` 条为审计保留窗口。
- **chain retirement certificate**（`chainRetirementCertificates`，version 1，硬容量 256）：每条终结 chain 一条（rootSequence/lineageId/finalAttemptId/finalGeneration/terminalState——footprint 与 generation 数量无关）。满载时最老非 legacy certificate 的 root 序号先进 retired range（read-back）再驱逐（legacy/arbitrary root 永久 pin——不猜测进 watermark）。
- **retired range**（`retiredAttemptRanges`，version 1，硬容量 64）：已退休发行序号区间，相邻单调合并（`[a,b]+[b+1,c] → [a,c]`——不吸收不相邻序号，绝不把未退休 ID 误判 retired）；被逐出 certificate 的 chain 与独立退休的 initial attempt 由 range 永久阻断重放（详细 outcome 压缩后 resolver 返回 retired——不猜测）。
- **ti1_ 防伪**：`executeTreasuryActionContract` 拒绝 seq > watermark 的 ti1_ ID（`transaction_id_not_issued`）；复用由 replay gate 阻断；production 调用方必须经 mint/capability（`treasuryWriteArchitecture` 架构扫描守护——production 源码的 contract 通道调用文件必须引用 mint/capability）。

## reservation 生命周期（owner / transfer / consume / release）

- store：`Memory.runtime.treasury.completionHeadroomReservations`（version 1；key `hr:<transactionId>`；entry = transactionId + reservedAtTick + boundIdentityDigest?）。容量不变量：live completion + reserved slots ≤ 128 恒成立（acquire 判定；ensureHeadroom 与 write readiness blocker 全部计入 reserved）。
- **acquire**（prepare 成功返回前；幂等——同 ID 重复 prepare 返回同一 reservation，不重复计数；reserved 有唯一 owner = transactionId/handle）。
- **admit + bind**（execute 的 final admission——durable Intent 写入 / executing 迁移 / capability 消费 / child_active / Game callback **之前**）：reservation 在位且与最终 durable identity digest 绑定一致（read-back）；失败 → callback 零调用、零 Intent、零消费、零推进、全部预留释放。
- **consume**（completion authority 接管——`cleanupStageAcknowledgement` 的 completion 写入成功后；live entry 已占槽，消除双重计数）。
- **release**（确定未开始：execute 全部 prepare_rejected 分支 / 显式 abort / tick 边界 invalidate 的 prepared handle / final admission 失败）。
- **保留**（execution unknown：callback 抛错 → faulted + quarantine 接管；TTL sweep 检查 durable intent 与 quarantine——在则不释放，直到 resolution cleanup 写 completion 后 consume）。
- **TTL**（1000 ticks）：reservedAtTick + TTL < Game.time 且无 durable intent/quarantine 且非 active handle 才释放（beginTick 有界 sweep ≤ reservation 数）。

## callback 前状态顺序（final admission 前移后）

独占 reservation 验证 + exact identity 绑定 → durable Intent 写入 → intent read-back → capability 消费 → executing 迁移 → child_active → Game callback → completion publication 消费 reservation。admit 失败（缺失/失效/冲突/unhealthy）：callback = 0、无 executing Intent、capability 不消费、lineage 不推进（T14/T15 验证零 Intent + capability 可恢复 + lineage 前置状态）。

## existing historical record 删除前 revalidation（修复三）

archive 幂等路径（existing record）先完整 `validateHistoricalRecordShape`（schemaVersion / archivedAtTick 安全整数 / via 枚举 / profile↔class 唯一组合 / 键一致 / digest hex / lineage 矩阵 / exact identity 可构造）；`deleteCompletionAfterAuthority` 的最后一步之前再从 Memory 权威直读并完整验证一次（heap 与 Memory 同对象——shape 复验抓热缓存后篡改）。任一失败 → blocked、completion 保留。T8 覆盖 7 维篡改：schemaVersion=99 / archivedAtTick=NaN / 非法 via / profile-class 冲突 / outcome 改写 / durableIdentityDigest 修改 / lineageDisposition 非法。

## profile 隔离（修复五）

- `TreasuryAttemptProofClass` 增 `forensic`（exact identity 构造经 `treasuryProofClassOfPersistedClass` canonical 转换——forensic 不折叠为 legacy；不同 class 即身份冲突，同 class 才可能 match）。
- `archiveTreasuryCleanupCompletionViaAuthority` 入口 `treasuryProfileAllowsAutomaticProtocol` gate：legacy-replay / forensic-isolated 的 completion 不得被 automatic archive / compact-archive / headroom reclaim 删除（`profile_isolated` blocked；满载 fail closed——T9 验证隔离 profile 填满后新 writer callback 零调用、completion 均保留）。
- `activateTreasuryLineageChild` 归档前移：parent completion 先 exact archive/read-back 再推进 child_active；blocked → 拒绝推进（lineage 保持 child_intent_pending 可恢复）。summary compaction 的 archive 结果结构化上报（`completionArchivePending`——不再无条件 void 忽略；架构测试守护 production 源码不得出现 `void archiveTreasuryCleanupCompletionViaAuthority`）。

## T1–T19 对应测试名（treasuryRound22RemediationVII.test.ts，42 tests）

| 反例 | 测试 |
| --- | --- |
| T1 | "T1：Receipt/Tombstone GC 后 historical committed 仍阻止 replay › 完整生命周期：committed → cleanup → 压缩归档 → receipt retention 到期 → tombstone 驱逐 → global reset → 同 ID prepare already_settled、execute callback 零调用" |
| T2 | "T2：historical not-executed 同 ID 只能 rearm › direct prepare parent ID → rearm_required；伪造 tr1_ child ID / 旧 child ID 拒绝" |
| T3 | "T3：historical opposite proof 双方向"（A/B/同方向 3 例） |
| T4 | "T4：historical committed 与 rearm-ready lineage 同 ID 冲突 › rearm preflight → proof_conflict、零 capability、零 mutation" |
| T5 | "T5：historical/证书中的 child ID 属于 occupied"（historical occupancy + certificate generation 区间 2 例） |
| T6 | "T6：historical outcome 相反的 reconciliation 阻断" |
| T7 | "T7：historical store unhealthy 时全部入口 fail closed"（prepare/opposite 双方向/rearm/child occupancy 4 例） |
| T8 | "T8：existing historical record 热缓存后篡改"（7 维 it.each） |
| T9 | "T9：隔离 profile 的 completion 不参与 automatic archive"（legacy/forensic 各 1 + 满载 fail closed 1） |
| T10 | "T10：独占 reservation 的容量竞争" |
| T11 | "T11：重复 prepare 的 reservation 幂等" |
| T12 | "T12：确定未开始路径的 reservation 释放"（abort/expired/invalid authorization/binding 失败 4 例） |
| T13 | "T13：execution unknown 的 reservation 保留" |
| T14 | "T14：prepare 后容量变化窗口"（reservation 在 → 满载仍可执行；reservation 失效 → 零 Intent 零 callback 2 例） |
| T15 | "T15：tr1_ 的 final admission 顺序"（capability 未消费、lineage 可恢复前置、零 Intent） |
| T16 | "T16：global reset 各窗口的 reservation 一致性"（窗口 1/2、窗口 4、窗口 6 共 3 例） |
| T17 | "T17：300-generation chain 的 terminal 压缩" |
| T18 | "T18：600 initial attempts 跨越旧 384 边界持续运行" |
| T19 | "T19：issuer 单调、防伪、防复用、correlation 隔离"（4 例） |
| T20 | `treasuryWriteArchitecture.test.ts`（28 tests 内）："production contract 通道调用方必须经 mint/capability 取得 transactionId"、"production 源码不得以 void 忽略 completion archive 结果" |

## 真实 300-generation 循环与压缩结果

- T17 实际执行 `for (let generation = 1; generation <= 300; generation++)`（root generation 0 + 300 child——正式 converge/settleParentCleanup/stage/activate/retire helper，每 50 代 Game.time 推进 5001+ + heap reset）。
- terminal compaction 后实际永久 entry 数：historical **0** 条（chain 压缩——root + 300 children 全部退休）、chain certificate **1** 条（finalGeneration=300、terminalState=non_rearmable_retired）、retirement summary 1 条。
- root 与 generation 1..300 全部经 resolver exact not-executed 可查（GC + heap reset 后仍成立）；错误 outcome 视角 → conflict；generation 301（超界）→ absent。
- Remediation VI 的 T9（同轮更新）断言同步升级：压缩前在 historical 层验证 exact identity 冲突、压缩后验证 certificate/resolver 层（301 → 0 + certificate 承载）。

## 超过旧 384 边界的持续运行

- T18 实际处理 **600 个** ti1_ initial attempts：historical 每到 384 硬容量触发正式压缩通道 `compressTreasuryRetirableHistoricalEntries`（range 吸收退休序号——不人工清库）；全部 600 ID 重放判定无 absent（retired 或 exact）；retired range ≤ 64、historical ≤ 384、certificate 0；watermark ≥ 600（reset 后不回退）；新 minted ID 走真实 prepare → execute（callback 恰一次 committed）。

## 操作数（性能）

- resolver 查询链全部 O(1) 单 key（live/historical/certificate byRoot/byLineage 索引 + tr1_ ID 自带 (lineageId, generation) 解析）；retired range 扫描 ≤ 64。
- ensureHeadroom/reclaim 扫描 ≤ completion 硬容量 128；压缩扫描 ≤ historical 硬容量 384 + 每次压缩量 ≤ 64（有界）。
- query 路径零写（resolver 只读）；state-changing preflight 可做有界压缩。
- global reset 首次 load 按硬容量一次有界验证。

## 验证命令与结果（全部本地实际执行）

| 命令 | 结果 |
| --- | --- |
| `git diff --check` | 通过（无 whitespace 错误） |
| `npx tsc --noEmit -p tsconfig.json` | 通过（零错误） |
| `npm run build` | 通过（`dist/main.js` created；rollup 无循环依赖警告） |
| `npx jest --config jest.config.cjs src/runtime/treasury/treasuryRound22RemediationV.test.ts src/runtime/treasury/treasuryRound22RemediationVI.test.ts src/runtime/treasury/treasuryRound22RemediationVII.test.ts src/runtime/treasury/treasuryWriteArchitecture.test.ts` | 4 suites，127/127 passed |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 72 suites，1382/1382 passed |
| `npx jest --config jest.config.cjs`（全仓） | 272 suites，2203/2203 passed（0 failed / 0 pending / 0 todo） |
| `node scripts/verify-jest-budget.mjs` | JEST_TEST_BUDGET=PASSED |
| `sha256sum dist/main.js` | `3f1261b1a2a2373529a22ea000b4f2e7f7e5059192ebd6e5d1811211a489366d` |

## 未部署声明

本轮未部署到 Screeps、未合并 main、未 rebase/force push、未调用真实 terminal.send / market / lab / factory / nuker / carrier 等经济 writer、未在线调参 Defense 常量；所有 Game 写动作测试使用 mock/spies。GitHub 无独立 CI——以上全部为本地实际执行结果。

## 剩余风险与限制

1. arbitrary ID（非 ti1_）在低层 `prepareTransaction`/`executePreparedAction` 通道仍可用（测试域）；production contract 通道经架构守护强制 mint/capability + ti1_ 防伪——未来 production writer 若绕过 actionContracts 直连低层接口，需要新增架构守护（当前生产无此调用点）。
2. retired range 满载（64 条且无相邻可合并）时 chain certificate 满载驱逐会 fail closed（compaction 延迟、active lineage 保留——不丢事实，但压缩停滞直至 range 合并窗口出现；正常按序退休下区间单调收敛不会触发）。
3. 隔离 profile（legacy-replay/forensic-isolated）的 completion 永久占用 live 容量（设计语义——显式管理路径处理前不自动回收）；若隔离 entry 填满 128 live store，新 writer fail closed 直至显式处理。
