# Round 22 — Marker Cleanup Atomicity & Explicit Proof Profiles（本地验证证据）

- 日期：2026-09-02
- 分支：refactor/empire-treasury-rearchitecture
- 预期起始 HEAD：c022a4c79bbee8c1e1a9e064fa0aab40e9050f61
- 实际起始 HEAD：c022a4c79bbee8c1e1a9e064fa0aab40e9050f61（一致）
- 最终 HEAD：见本 evidence 对应 commit（git log）

## 1. 本轮交付总览

新模块（7 个窄职责）：
- `identityProfile.ts`：四枚举 profile（modern-contract/lowlevel/legacy-replay/forensic-isolated）的 required/forbidden 矩阵、确定性推导（迁移用）、class 唯一映射、自动协议参与判定——单一权威。
- `markerExactIdentity.ts`：marker v4 exact identity（显式 profile + 顶层完整事实 + lineage 四字段）；relation 六值（match/conflict/insufficient/unrelated/store_unhealthy），显式比较 lineageId/generation/parent/binding；v3 兼容读取（携带维度，不冒充）；v2 缺链绑定 insufficient；v1 legacy insufficient。
- `markerDischarge.ts`：discharge 协议（relation → 匹配删除 → Memory read-back → 结构化结果）；七值结果（already_absent/matching_cleared/unrelated_global_lock/conflict/insufficient/store_unhealthy/delete_failed_or_still_present）；attemptMarkerDischarged 与 globalWriteAdmissionStillLocked 两事实分离。
- `resolutionCleanupJournal.ts`：持久 cleanup 状态机（Memory.runtime.treasury.resolutionCleanup v1，容量 256）；四阶段布尔（markerDischarged/authorityReleased/outcomeFinalized/lineageFinalized）；journal 即 pending 索引（global reset 重建）；恢复编排（hooks 注入——production 装配 fail closed）。
- `trustedSettlementProof.ts`：release-trusted receipt 读取（attempt 绑定 + exact relation；identity_conflict 与 absent 分流）。
- `currentSettlementCoordinator.ts`：cross-store settlement 结论判定（committed_verified/not_executed_verified/conflict{sources}/insufficient/store_unhealthy，全部单 key 查询）；相反 proof 显式不存在检查（verifyTreasuryOppositeProofAbsence）。
- `generationProofLifecycle.ts`：慢速 rearm 的孤儿 GRA proof 有界清理（advance 后单代 O(1) 查询 + 依赖检查）。

## 2. Marker exact identity 矩阵

| marker 形态 | 判定 |
|---|---|
| v4（markerProtocol 4） | profile/class/四维 digest/lineage 四字段全维比较；requiredness 缺失 → insufficient；forbidden 携带 → conflict |
| v3（markerVersion 3/lineageId） | digest/class/provenance/lineageId/binding/generation 携带维度 match（不冒充 parent 维度） |
| v2 | tr1_ 场景缺 lineageId → insufficient |
| v1（无 class 字段） | 同 transaction → insufficient（fail closed 保留） |
| transactionId 不同 | unrelated（不删除，global lock 保留） |
| malformed | store_unhealthy（零状态变化） |
| generation 0（root 平凡维度） | expected 携带 0 不构成 marker 必须携带（携带则比较） |

## 3. Marker discharge 结果矩阵与 read-back

- already_absent / matching_cleared / unrelated_global_lock / conflict / insufficient / store_unhealthy / delete_failed_or_still_present。
- matching 删除后重读 Memory：absent → matching_cleared；变成其它 transaction → unrelated_global_lock（当前 attempt 已解除）；仍同 transaction → pending；malformed → store_unhealthy。
- forensic 通道独立清除入口（clearTreasuryForensicMarkerForAcknowledgedRollback——acknowledge-rolled-back 人工协议，v4 顶层或旧嵌套按 marker 自身协议比较）。

## 4. committed / not-executed cleanup 状态机与中断窗口

journal 阶段：settlementProofDurable（创建即 true）→ markerDischarged → authorityReleased（read-back not_found）→ outcomeFinalized → lineageFinalized → entry 删除（唯一合法删除点）。

安全顺序（faultResolution staged 已重排）：marker discharge **先于** authority release——marker 清除时 Authority 仍在（可继续阻断 writer）；中断后 Intent/Quarantine 仍阻断。中断窗口（journal+tombstone/receipt 持久重建）：
- committed：resolving tombstone 写入后 reset / discharge 前 / release 后 read-back 前 / finalize 前 / close 前。
- not-executed：final tombstone 后 / discharge 前 / release 后 / exact proof converge 前 / lineage 终态前。

## 5. Replay-readable vs release-trusted Receipt

- replay-readable（lookupTreasurySettledReceipt/readTreasurySettlementProof）：单键探测、零写、容忍损坏（防重放与诊断）。
- release-trusted（lookupTreasuryTrustedSettledReceipt → readTreasuryTrustedSettlementProofForAttempt）：完整 load/migration（每 heap 一次有界全表扫描，随后 O(1)）；任一 entry 损坏/版本未知 → store_unhealthy；legacy → legacy_insufficient；exact 冲突 → identity_conflict。
- 使用 release-trusted 的路径：coordinator 的 committed 结论、journal 的 authorityRelease handler、child-active 恢复（经 coordinator）。

## 6. Cross-store settlement coordinator 结论矩阵

committed_verified 需要：trusted receipt exact match + semantic committed purpose + 无 final not-executed tombstone + 无 GRA not-executed proof + Intent/Quarantine committed-compatible（returned_non_ok 矛盾拒绝）+ resolver 非 inconsistent + marker 不属于当前 attempt + 全 store 健康（lineage/summary health source 装配注入）。
not_executed_verified 需要：matching final tombstone + matching exact GRA proof（tr1_）+ semantic retirement purpose + 无 trusted committed receipt/tombstone + authority not_found + marker 不阻断。
child-active 恢复接线（9.4）：verifier verified 后必须 coordinator committed_verified 才 close + release。

## 7. Purpose-aware semantic lineage 矩阵

七 purpose（handoff/current_execution/committed_settlement/not_executed_retirement/tombstone_replacement/historical_diagnostic/authority_resolution）；purpose 必填（缺失 → store_unhealthy fail closed）。committed_settlement：current（child_active/chain_committed）+ terminal_current（仅 chain_committed）；同代 GRA not-executed proof → conflict。not_executed_retirement：retiring/rearm_ready/non_rearmable；committed 轨道 conflict。receipts gate 布尔删除（refresh 与 commit 均 committed_settlement）。

## 8. Identity profile 持久化与迁移

- Lineage store v2→v3（record.identityProfile；root identity 推导；partial → 整 store fail closed）；transition 经 update spread 保留（不可变）；create 缺省推导（失败拒绝创建）。
- GRA store v1→v2（proof.identityProfile；同推导规则；legacy-replay 放宽历史 class 映射；partial → fail closed）。
- Summary：v3 exact 主 store + **legacy replay archive**（Memory.runtime.treasury.legacyRetirementSummaries）双平面——v1→v2 迁移后 v2 整体拆 archive（不再阻断未来 exact 压缩）；root/lineageId lookup 双平面（archive 的 root 重放门禁永久保留，v2 entry 在 semantic 层 replay-only insufficient）；双平面 root identity 冲突 → 压缩拒绝。summary 的 profile 由 rootExact/finalExact 的 canonical 推导绑定（rootExact 推导与 authorityClass 一致性强制）。
- Marker v4 显式 profile（写入侧 exactMarkerFieldsOfPreparedRecord/exactMarkerFieldsOfAttemptFacts；authorizationLedger 不再写旧嵌套）。

## 9. Summary canonical 自验证（十五节）

v3 shape 校验新增：finalAttemptId 派生重算、finalGeneration≥1 的 parent/binding 权威重算、rootExact profile 推导与 authorityClass 一致（partial → store unhealthy）。lineageId 的 root 绑定派生由 GRA 的 computeLineageIdFromRootBinding 承载（summary rootIdentityDigest 含 provenance 回落口径与 record 派生口径存在已知设计差异——双口径不在此重复强制，如实记录）。

## 10. Terminal compaction 相反 proof 拒绝（十六节）

compactTerminalLineageRecord 在 summary 写入前显式 verifyTreasuryOppositeProofAbsence：chain_committed 目标拒绝 matching final not-executed tombstone/GRA proof；non_rearmable 目标拒绝 trusted committed receipt/tombstone；exact identity 匹配（同 ID 其它 attempt 不误阻断）。

## 11. Slow-rearm 孤儿 proof（十三节）

sweepTreasuryOrphanGenerationProofOnAdvance：advance 成功（record.generation > retired）+ tombstone 已驱逐 + resolver not_found + 无 receipt + 无 journal pending + store 健康 → 释放。接线：facade activate 成功后 + attemptLineage forward 完成后 + beginTick 恢复循环（generation-1 确定性补清理）。

## 12. Backfill marker 冲突修复（十二节）

backfillLineageFromTombstone 的 markerCleaned 自定义 boolean 删除——统一 exact relation（unrelated/absent 才 cleaned；match/conflict/insufficient 保持 false——同 transaction digest 冲突不再误判 cleaned）。

## 13. Result 语义（十七节）

TreasuryFaultResolutionResult 增加 globalWriteAdmissionStillLocked（17.3 两事实分离）+ marker_cleanup_blocked reason（committed discharge 未完成的显式拒绝状态）。

## 14. 验证结果（本地，无独立 CI）

- npx tsc --noEmit -p tsconfig.json：0 错误。
- npm run build：成功（bundle sha256 7dcf10a7e127bd1e…）。
- Treasury 定向（treasuryRound22*）：18/18。
- Treasury 全量：64 suites / 1150 tests 全部通过。
- 全仓 Jest：259 suites / 1856 tests / 1856 passed / 0 failed / 0 pending / 0 todo。
- node scripts/verify-jest-budget.mjs：budget 提交后 PASSED（见 budget commit）。
- GitHub CI：本仓库无 workflows（无独立 CI 证据——只报告本地验证，不声称 CI passed）。

## 15. 既有测试 fixture 升级说明

- Round 16/14/13 marker fixture → v4 形状（旧嵌套式 insufficient 语义保留为显式用例）。
- Round 20/21 GRA fixture schemaVersion 2 + identityProfile。
- Round 19 v1 迁移测试 → v1→v2→archive 链新断言；满载测试 → 合法 v3 塞满（canonical 真实派生）。
- Round 20 receipt heap publish 恢复用例 → 显式 committed resolution（9.4 marker 未 discharge 不关闭）。
- 语义测试的 validator 直接调用统一补 purpose: "historical_diagnostic"（base verdict 透传）。

## 16. 真实 writer 边界

- production writer 文件（resourceControl/marketDirectContinuousAutomation/marketSaleProtection(+Adapter)/factoryControl/synthesisControl/nukerControl/terminalActionEnergyOwnership）本轮 diff 为空（git show 可核验）。
- 全仓扫描 terminal.send/Game.market.deal/runReaction/boostCreep/unboostCreep/factory.produce/launchNuke/creep.transfer/creep.withdraw/creep.drop/creep.pickup/spawnCreep：零真实调用（测试 mock/adapter kind/字符串除外）。
- 未部署、未合并 main、未 force push、未调用任何真实 Game API。

## 17. Orthogonal Defense Sidecar（附加工作包状态）

按附加包执行顺序要求，本轮优先完成 Treasury Round 22 安全修复（已完整、测试全绿、独立提交）。Defense focus-fire sidecar（Tower/主防 Creep 协同）为正交工作，未混入任何 Treasury commit；其状态在最终交付报告中单独说明。

## 18. 不得勾选项（维持）

terminal.send adapter 真实实现 / plan shadow / reconciliation shadow / 真实执行；ResourceControl、market、carrier/lab/factory writer；live CPU canary；完整 Budget Service；ReceiverCapacityLedger 替换；旧库存系统删除——均未开始。

## 19. 剩余风险

- summary lineageId 双口径（rootIdentityDigest 的 provenance 回落）为既有设计，本轮如实记录未收敛。
- legacy-replay profile 的既有 GRA proof 在 capability 门禁的显式拒绝未单独加 gate（coordinator 的 profile 检查已挡 settlement 路径）——后续 round 可补。
- Screeps hard CPU interruption 与 Memory flush 仍不提供 exactly-once 保证（本轮协议以持久可恢复性对冲）。
