# Round 22 Remediation — journal 持久化 / marker-first 顺序 / trusted 删除门禁 本地验证证据

- 变更分支：`refactor/empire-treasury-rearchitecture`
- 代码提交（本 evidence 的验证 HEAD）：`79e6c7f2f18e9a48d3c580aae488ffaa89a55ed1`
- 验证日期：2026-09-02（本地环境，未部署、未调用真实 Game 写 API）
- 上一基线：`84d1048f8a9495f7b1d673570ca98a0bd20a36c6`（Round 22 终态）

## 0. 审计结论（修复前真实缺陷）

Round 22 初版存在六类真实缺陷，本次 remediation 全部修复：

1. **journal 从未真正持久化**：`loadCleanupRuntime` 首次初始化只建 heap-only
   store，未写回 `Memory.runtime.treasury.resolutionCleanup`——global reset
   后全部 cleanup 阶段进度丢失。
2. **两处 release-先于-discharge**：`resolutionStore.recoverStagedResolutions`
   的 committed 分支（先 releaseTreasuryQuarantine/IntentEntry 后 discharge）
   与 pendingRelease authority-present 分支同序错误。
3. **facade executed-aborted 与 resolutionAuthority 两个生产 caller 仍使用旧
   boolean clear 包装器**，且以 `readTreasuryWriteFault()?.transactionId !==
   currentId` 作为 markerAbsent 证明（unrelated 冲突不可区分）。
4. **discharge 前无完整 marker shape 校验**（phase/status/tick/recordedAt/
   kind/source）；read-back 无 shape 校验（null 非对象会抛 TypeError）；
   expected 自身不过 profile requiredness 矩阵（v4 分支按
   `expectedValue === undefined` 跳过比较）。
5. **journal reopen 覆盖身份字段**（保留阶段进度同时用新 input 覆盖
   identity）；阶段标记无前置顺序约束。
6. **GRA 孤儿 proof 删除门禁用 replay-readable receipt lookup**；无 matching
   write-fault marker 检查；journal unhealthy 折叠为 entry absent。

## 1. A 项 — cleanup journal 真实持久化

- `loadCleanupRuntime` 首次初始化后立即 `cleanupBranch().resolutionCleanup =
  store` 写回 Memory（resolutionCleanupJournal.ts）；heap 缓存只是同一
  Memory 权威 store 的引用。
- 全部 entry 写入 / 阶段推进 / 删除作用于同一 Memory 可达 store（open /
  mark / complete 均经 loadCleanupRuntime 返回的 store 引用）。
- test-only 操作拆分：
  - `clearTreasuryResolutionCleanupDurableForTest()`：删除 Memory 数据；
  - `resetTreasuryResolutionCleanupHeapCacheForTest()`：只清 heap、不删
    Memory（global reset 模拟专用）。
- 结构化健康：`peekTreasuryResolutionCleanupHealth()` →
  `{healthy, detail}`；unhealthy 时 open rejected、恢复编排 blocked（负计数
  报告）、GRA 清理 retained——不折叠为 entry absent。

## 2. B 项 — marker → authority 顺序收敛（生产面全量审计）

六类调用（releaseTreasuryIntentEntry / releaseTreasuryQuarantineEntry /
clearTreasuryWriteFaultMarkerForResolution / dischargeTreasuryMarkerForAttempt /
markTreasuryPendingReleaseCompleted / convergeTreasuryLineageRetirementFromFacts）
生产审计结果：

- `resolutionStore` committed 分支：journal open（幂等）→ discharge +
  read-back → mark → release quarantine/intent → authority read-back
  not_found → mark → finalize final tombstone → mark outcome → initial
  attempt 当场完成 lineage 并删除 entry；tr1_ 留 beginTick journal recovery。
- `resolutionStore` pendingRelease authority-present 分支：同一顺序（discharge
  先于 release；释放后 read-back not_found 才推进阶段与移除索引）。
- `resolutionStore` pendingRelease not_found 分支（authority 已释放的历史
  遗留窗口）：journal 幂等补开 + marker discharge 补清；journal
  rejected/conflict 不折叠为"已完成"。
- `facade` executed-aborted rearm cleanup：删除旧 boolean clear 与
  `readTreasuryWriteFault()?.transactionId` 比较式 markerAbsent；改为
  open journal → discharge → read-back → release intent → intent read-back →
  converge → pending-release 移除；malformed/conflict/insufficient 时 intent
  保留、retirement `pending_cleanup`、索引不推进。
- `resolutionAuthority` acknowledge-rolled-back 主路径与 already_resolved
  幂等重入路径：同上接入 discharge + journal（forensic marker 的显式人工
  通道 `clearTreasuryForensicMarkerForAcknowledgedRollback` 保留——它不是
  旧 boolean clear）。
- `beginTick` 顺序：handoff 证据 → intent recovery → recoverStagedResolutions
  → journal recovery → lineage recovery。两套恢复逻辑共享 journal 单一
  pending 权威与同一阶段顺序（不存在第二套顺序）。
- **旧 `clearTreasuryWriteFaultMarkerForResolution` 已无生产 caller**（仅
  兼容实现保留 + 测试引用）；facade/faultResolution 的 unused import 已删。
- pre-execution 路径（prepare 拒绝 / rearm capability 无效 / rollback /
  forward 等的 intent 释放）不涉及 marker 清除组合（无 settlement proof、
  无 unresolved marker），不属于本次顺序管制面——审计确认。

## 3. C 项 — discharge 的完整校验

- discharge 前完整 `validateTreasuryWriteFaultMarkerShape`（phase/status/
  tick/recordedAt/kind/source 及全部身份字段形状）：任一非法 →
  store_unhealthy，marker/authority/journal 全部保留，零状态变化。
- read-back 新 marker 完整 shape 校验：null/非对象/缺基础字段 →
  store_unhealthy（不抛异常、不当 unrelated）；read-back 为其它合法
  transaction → unrelated_global_lock（两事实分离）；同 transaction →
  delete_failed_or_still_present。
- expected attempt 自身通过 `validateTreasuryIdentityProfileFacts`：
  modern-contract 缺 contract/cohort/durable、lowlevel 缺 durable/受控
  source → insufficient（不按 undefined 跳过维度比较）。
- read-back malformed 分支经 prototype-getter 注入技术直接覆盖（delete
  no-op 于 own property，read-back 再走 getter 返回 malformed 值）——
  非对象与缺基础字段两形态均验证。

## 4. D 项 — journal identity 不可变与阶段顺序

- reopen（同 transactionId 同 resolution）要求 digest/identityProfile/
  proofClass/contract/cohort/durable/lowlevelSource/lineageId/generation/
  parent/binding 全部 exact 相等（undefined ≠ 值 → conflict）；任何冲突
  零状态变化（阶段进度与身份字段均不覆盖）。
- `treasuryResolutionCleanupOpenInputOfFacts` 单一构造权威（profile 按
  proof class 唯一映射 + 字段按携带透传），faultResolution / resolutionStore
  / resolutionAuthority / facade 四类调用点共用，消除构造差异伪 conflict。
- `markTreasuryResolutionCleanupStage` 强制 marker → authority → outcome →
  lineage 前置顺序；越级返回 false 零状态变化。

## 5. E 项 — GRA destructive cleanup 只用 trusted 读取

`sweepTreasuryOrphanGenerationProofOnAdvance` 删除前依次确认：

1. GRA store healthy；2. active lineage record 存在且 generation 已真实推进；
3. proof.identityProfile 与 record.identityProfile 一致（不可变约束）；
4. resolution store healthy；5. tombstone 不存在；6. unresolved authority
not_found；7. **release-trusted** receipt lookup 为 absent（store 任一无关
entry 损坏 / legacy / 未知版本 → retained——replay-readable lookup 不再作
删除门禁）；8. cleanup journal healthy 且无 pending（结构化健康结果，不
折叠）；9. matching write-fault marker 不存在（malformed → retained）。

任一不满足 → retained（结构化原因），零状态变化。测试覆盖：基线 released、
unrelated receipt 损坏、journal 损坏、journal pending、matching marker 残留、
marker malformed、receipt 未知版本。

## 6. F 项 — purpose 必填契约

- `validateTreasurySemanticLineage` 的 purpose 改为非可选
  `readonly purpose: TreasurySemanticLineagePurpose`（运行时 defensive
  check 保留）。
- 架构测试（源码断言）防止回退为 optional；生产调用面测试锁定 7 个生产
  调用点全部显式携带 purpose。
- unresolvedAuthority 三个 ok 路径（intent-only / quarantine-only /
  quarantine+intent 双一致合并）以真实 tr1_ chain fixture 直接回归
  （purpose=authority_resolution 的 semantic gate 全部通过）。

## 7. 测试矩阵（treasuryRound22Remediation.test.ts，32 tests）

- A（4）：Memory 挂载、global reset 恢复（只清 heap、不重新 open、JSON
  round-trip、identity+阶段全量断言）、test 函数语义分离、损坏 journal 的
  结构化 unhealthy + open rejected + 恢复 fail closed。
- B（6）：六个中断窗口（settlement proof 后 / marker discharge 前 / marker
  read-back 后 authority release 前 / authority release 后 read-back 前 /
  outcome finalization 前 / lineage finalization 前）各自执行真正的 heap
  reset（journal + resolutionStore + quarantine 缓存）后从 Memory 恢复、
  不重新 open；handlers 未装配 → fail closed 保留全部 pending。
- C（7）：非法 phase / 非法 status / 非法 tick+kind+source / null 与非对象
  与缺 transactionId marker / expected 缺 required（modern-contract 与
  lowlevel）/ marker 完整 expected 携带额外 lineage 维度（insufficient）/
  read-back malformed（prototype-getter 注入）。
- D（3）：reopen 六字段冲突矩阵 + exact 相等幂等；不同 resolution
  conflict；越级 mark 拒绝 + 合法全链。
- E（7）：如上。
- F（6）：类型契约源码断言、生产调用面 purpose 断言、运行时 defensive、
  三个 ok 路径回归。

## 8. 最终验证（HEAD = 79e6c7f2f18e9a48d3c580aae488ffaa89a55ed1）

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| `npm run build` | 成功（bundle sha256 `1f952f2f4206c383…`） |
| `npx jest --config jest.config.cjs src/runtime/treasury/treasuryRound22Remediation.test.ts` | 1 suite / 32 tests 全过 |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 66 suites / 1182 tests 全过 |
| `npx jest --config jest.config.cjs` | 260 suites / 1888 tests 全过（0 failed/pending/todo） |
| `node scripts/verify-jest-budget.mjs` | `JEST_TEST_BUDGET=PASSED`（260/1888；budget 提交锚定本代码提交） |

budget（verify-jest-budget.mjs 锚点 + test-suite-budget.json + manifest）在
代码提交 `79e6c7f` 之后更新并以独立提交入库；此后无 Treasury 代码变化。

## 10. 最终验证附记（Defense sidecar 提交后复验）

Treasury 代码在 `79e6c7f` 之后零变化（后续提交为独立的 Defense
Focus-Fire sidecar `194631f`/`8ac8d88` 与 budget/evidence `3bc4bd1`/
`887f217`，均不触碰 `src/runtime/treasury/`）。最终分支 HEAD
`887f2174f97ea5da6651dfa1e395b0d17849ac60` 上复验全套命令：
`tsc` 0 错误；`npm run build` 成功（bundle sha256 `490f74e9cd096930…`）；
Round 22 marker discharge 定向 18/18；Treasury 全量 66 suites/1182 tests；
全仓 261 suites/1902 tests；`verify-jest-budget` PASSED。

## 9. 遗留与如实声明

- `clearTreasuryWriteFaultMarkerForResolution` 保留为兼容实现（无生产
  caller）；既有测试直接引用它做兼容性断言。
- read-back malformed 的覆盖采用 prototype-getter 注入（生产代码该窗口为
  同步语句，无其它可注入路径）；其判定与入口 malformed 共用同一 shape
  校验函数。
- facade journal stage handlers 的 trusted receipt / final tombstone 验证
  语义由既有 Round 22 测试承载；本次窗口测试装配与生产 handler 同构的
  测试 handlers，验证编排顺序与幂等。
- 测试中的 mock store 手工构造（quarantine/receipt）不构成对真实
  Game API 的任何调用。
