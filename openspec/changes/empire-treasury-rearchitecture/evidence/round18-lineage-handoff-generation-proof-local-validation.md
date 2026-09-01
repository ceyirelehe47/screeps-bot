# Round 18 — Lineage Handoff Atomicity & Generation-Proof Closure（本地验证记录）

- 日期：2026-09-01
- 分支：`refactor/empire-treasury-rearchitecture`
- 起始 HEAD：`ebab140ff26034b2a4f39e250e2bec3e321ee76b`（Round 17 终态）
- 最终 HEAD：见下方 commit 列表末项（budget 提交前为 `710bdbc`）
- 预算基线（Round 17）：240 suites / 1573 tests
- 本轮终态：243 suites / 1633 tests / 1633 passed / 0 failed（真实执行）

## commit 列表（ebab140 → 本轮终态）

| SHA | 主题 |
| --- | --- |
| 2e682ff | docs(openspec): define round 18 lineage handoff and generation proof closure |
| c620d9f | refactor(treasury): enforce lineage index integrity, transition immutability and per-generation retirement |
| b26990b | refactor(treasury): make child handoff durable and strictly consumed |
| 2cfe947 | fix(treasury): publish lineage replacement before releasing authority |
| 0948858 | fix(treasury): close child pre-callback and non-ok lifecycle branches |
| cca479f | refactor(treasury): propagate generation proof across all durable stores |
| 33cb691 | refactor(treasury): add versioned adapter retry semantic facts |
| b2b4efa | fix(treasury): make contract source canonical across authorization and execution |
| a53918d | test(treasury): cover round 18 atomicity and lifecycle invariants |
| 710bdbc | fix(treasury): close round 18 test-driven gaps in source gate, summary reset and receipt proof |

## 1. lineage replacement staged 顺序（publication-before-release）

```text
prevalidate（authority/结论/proof class）
→ resolution slot 预检
→ lineage 容量 + retry facts 预检（零持久副作用）
→ lineage retirement candidate 持久化 + read-back
   （全字段 + identity 与 authority 完全匹配 + retirementGeneration 归属）
→ consume reconciliation capability
→ final not-executed tombstone（携带 tr1_ lineage proof）
→ 释放 quarantine / intent（authority release）
→ class-aware marker cleanup（检查清除结果）
→ 三段 verified → rearm_ready / non_rearmable_retired
```

- publication 写入/read-back/identity 失败 → `lineage_publication_pending`：intent/quarantine/marker/pending-release 索引全部保留、tombstone 不写、capability 不消费；下一轮从保留 authority 重建完整 retry facts（幂等重入：已 retiring 且 identity 匹配 → published 不重复推进）。
- release 成功但 marker 清除失败 → `pending_cleanup`（retiring 保持、tombstone/pending 索引保留）。
- 三段全部 verified 才移除 pending-release 索引、获得 retention 驱逐资格。

## 2. child handoff 状态图与中断窗口

```text
rearm_ready ──issue（handoff facts 冻结：nextChild=v2 ID + pendingBindingDigest）
  → capability_issued ──stage → child_intent_pending
    → intent 写入（携带 lineageId/generation/parent/binding）+ read-back
    → consume（严格：state=child_intent_pending && revision=签发+1 && binding 矩阵）
    → execution-started（intent → executing：callback 可能已开始的唯一持久信号）
    → child_active（current/generation/binding 接管；retirement 按新代复位）
    → Game callback
      ├─ pre-callback 失败 → 同步回滚 rearm_ready（consume/started 失败）或
      │   前向补完成（armed 推进失败：intent 留在 executing）
      ├─ non-OK + abort 确认 → 当前代同步 retirement → rearm_ready（下一代）
      ├─ throw/未知 → quarantine → resolver（同一 generation 推进）
      └─ OK + commit → receipt（lineage proof）→ chain_committed
          （终态写失败 → lineageFinalizationPending + intent 保留，
           beginTick 按 matching receipt 补完成）
```

reset 窗口（beginTick，`classifyTreasuryHandoffRecoveryWindow` 单一权威）：

| 窗口 | 判定 |
| --- | --- |
| capability_issued（跨 tick/reset） | 回退 rearm_ready（child facts 保留，child ID 稳定） |
| child_intent_pending + intent 缺失且 quarantine 缺失 | 回滚 |
| + 一致 not_started/ready intent | 释放 intent 并回滚（不 forensic） |
| + intent 或 quarantine proof 冲突（binding/generation/lineage） | forensic_isolated（authority 保留） |
| + intent executing/更后，或 quarantine proof 匹配 | 前向补完成 child_active（不产生第二 child） |
| child_active + matching committed receipt | 补完成 chain_committed 并释放遗留 intent |

## 3. generation proof 字段语义（canonical 视图）

`{lineageId(16hex), lineageGeneration(≥1), parentTransactionId, lineageBindingDigest(16hex)}` + authorityClass（marker/proof 矩阵）：

- durable identity：tr1_ digest 输入包含完整 proof；initial 完全不包含——单侧缺失/不同 → conflict 或 insufficient，不得 match；
- `treasuryAttemptIdentityRelation` 双向 fail closed：attempt 携带而 proof 缺失 → insufficient（旧 proof 只作 replay blocker）；proof 携带而 attempt 缺失 → conflict；双方携带四字段全等才 match（parent proof 不能证明 child、generation N 不能证明 N+1）；
- same-ID 幂等公共前置加 lineage 比较（同 ID 不同 lineage/generation/binding 永远 conflict）；
- publication read-back 全字段比较（含 4 个 proof 字段——检测写入后 binding 删除/generation 篡改）；
- intent→quarantine 转移传播完整 proof 且 read-back 验证。

## 4. store 版本与迁移表

| store | 版本 | 变更 | 迁移 |
| --- | --- | --- | --- |
| attemptLineage | v1 → v2 | pendingBindingDigest / retirementGeneration / currentParentTransactionId / lineageId 索引 / child ID v2 | v1 next-child 不可寻址 → 回退 rearm_ready 清除（等价 capability 过期）；gen≥2 v1 child 无法证明 parent → forensic 隔离 |
| intents | v6 → v7 | lineageId/generation/parent 必填矩阵（tr1_） | 经装配注入 resolver 从 lineage 原子补全（current 命中 + binding 一致）；不可证明 → fatal（原数据保留） |
| quarantine | v5 → v6 | 同上 | 同上 |
| resolutions | v6 → v7 | lineageId/generation/parent/binding（tr1_ not-executed final） | 结构 passthrough + 全量重验证（不可证明 → verdict 永久 pin / preflight 阻断，不释放 authority） |
| receipts | v7 → v8 | proof lineage 四字段（整体携带或缺失；legacy 禁） | tr1_ receipt 缺完整 proof → lookup 降级 legacy_committed（只作 replay blocker，不释放当前 rearm authority） |
| write-fault marker | v2 → v3 | +lineageId（binding 携带时必填） | v2 兼容读取（class-aware 清除按 relation） |
| retirementSummaries | 新 v1 | 独立硬容量 128 | — |

## 5. index 完整性矩阵

- 四索引全 O(1)：lineageId / root / current / next（lineageId 读取不再扫描 entries）；
- load 全表 + 写入候选预检：duplicate lineageId/current/next、root≠他 record current/next、current≠他 record root/next、next≠他 record root/current/next、record 内组合状态语义（gen0⟺current=root）——冲突 → 整 store unhealthy（不静默覆盖、不自动删除）；
- Memory 写入成功但索引同步失败 → 回滚 Memory + runtime fatal（不留双套事实）；
- publication read-back 全字段比较（root/current identity、kind、adapter identity、owner、generation、state、resolution、child、retry semantic、class/source、binding、retirement、revision）。

## 6. transition 允许字段矩阵（摘要）

- exact idempotence 修复：完整一致（含 revision 一致）→ idempotent（revision 不 +1）；非幂等写严格 +1；
- 全局冻结：lineageId/root/rootIdentity/actionKind/adapterSemanticIdentity/owner/authorityClass/lowlevelSource/createdAtTick；
- current identity/generation/binding/parent 只在 `child_intent_pending → child_active` 接管转换同时变化；
- 同 state 仅 retiring 允许 retirement 标志/retrySemantic(undef→def)/rearmable(true→false)；
- updatedAtTick 不回退、generation 不回退不跳跃、rearmable 禁 false→true；
- 接管时 retirement 三段复位 + retirementGeneration 指向新代（上一代完成标志不得授权当前代驱逐）。

## 7. tombstone replacement verdict

`{replacement_match | replacement_pending | replacement_conflict | replacement_missing | store_unhealthy}`：

- match：ID 解析（v2）/root 命中 + generation ≤ 当前 + transactionId 等于该代期望 ID + proof class 一致 + binding 重算一致（携带时）+（当前代）digest 完整比较 + 三段完成 + retirementGeneration 归属；历史代（< 当前代）由状态机推进顺序证明（当前代 retiring 瞬态不影响历史代证明）；
- pending/conflict/missing/unhealthy → pin（conflict 计入 identityConflicts）；
- A→B→C 后 A/B tombstone 独立回收；旧 ID 仍被 tr1_ 门禁 + root 门禁阻断；单 chain 300 代重试 entryCount 恒 1、Resolution store 不满载（300 代真实执行通过）。

## 8. 多代退休 / terminal 压缩方案

- generation-addressable child ID v2：`tr1_<lineageId16>_<gen6hex>_<checksum8>`（checksum 绑定 root；O(1) 解析/验证/重算）——任意历史代 ID 与 binding 只凭 record 重算，无无界数组；
- active lineage（容量 64）保留进行中/可 rearm chain；chain_committed / non_rearmable_retired 在无 authority/marker/pending 时压缩为 retirement summary（beginTick 有界批处理 terminalIds ≤64；满载时容量预检先压缩）；
- retirement summary（独立 store，硬容量 128，key=root）：{lineageId, root, rootIdentityDigest, terminalState, finalGeneration, finalAttemptId, finalizedAtTick}——永久 root 门禁（prepare 含 summary 索引）、终态证明、O(1) 查询、不依赖 receipt/tombstone retention；
- summary 满载 → 不删旧、不压缩、新 chain 经容量门禁拒绝（fail closed）；forensic 不自动压缩；
- Memory 成本：active ≤ 64 × ~700B ≈ 45KB；summary ≤ 128 × ~250B ≈ 32KB。

## 9. adapter retry semantic 协议（v2）

- `adapter.retryFacts(args)`：canonical frozen args → 有界事实（键 ≤48/≤32 个、值 string ≤128/number/boolean、canonical 编码 ≤1024、异常 fail closed）；与 durableFacts 职责分离，必须覆盖全部改变真实 Game API 调用语义的参数；
- digest v2（treasury-retry-semantic@v2）：移除 adapterRegistrationId（注册顺序/global reset 稳定）；加入 retry facts（payload 相同 facts 不同 → digest 不同）；协议 tag 变化 → 旧 capability 失效；
- 未实现 retryFacts → 动作正常执行、not-executed 后 non-rearmable（immediate authorization-fault 路径同理）。

## 10. contract source 绑定

- build 时确定（缺省 `action-contract`）→ contract.source 字段 + AC4 digest（`src:` 成分）+ retry semantic + durable intent + kernel 输入；
- authorization 重算使用 contract.source（不再写死）；execution request 携带不同 source → contract 入口拒绝（callback 零调用）。

## 11. operation-count（treasuryRound18OperationCount.test.ts 全过）

- lineageId 读取：50 次 read 后 fullScans 不变；
- handoff recovery：pending lineage 的 beginTick 不全扫；
- verdict：30 次查询 fullScans 不变（索引 O(1)）；
- A→B→C：entryCount 全程 [1,1,1,1]；
- terminal 压缩：compactions +1、entryCount → 0；
- 空闲 beginTick：idleFastPath 递增、fullScans 不变。

## 12. 验证命令与真实结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| `npm run build` | 成功（bundle sha256 8a456a43…，无循环依赖警告） |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 49 suites / 928 tests 全过（定向） |
| `npx jest --config jest.config.cjs`（全量） | 243 suites / 1633 tests / 1633 passed / 0 failed |
| `node scripts/verify-jest-budget.mjs` | `JEST_TEST_BUDGET=PASSED`（243/1633） |
| 8 个真实 writer 文件 diff（ebab140..HEAD） | 空（无真实 Game writer 接入） |
| `git status` | 干净（提交后） |

## 13. 边界声明

- 未部署到 Screeps；未合并 main；未 force push / rebase / amend 已推送历史。
- 未接入任何真实 Game writer（terminal.send / Game.market.deal / lab / factory / nuker / creep 等）——全部验证为本地 Jest。
- GitHub 仓库当前无 CI——以上为真实本地执行结果，不声称 CI passed。
- Screeps hard CPU interruption 与 Memory flush 边界仍不保证 exactly-once（协议目标是 durable 状态机的可恢复性，不是 exactly-once）。

## 14. 下一阶段判断

协议链路（lineage publication 原子性 / handoff 恢复矩阵 / child 三类终态 / generation proof 闭环 / per-generation retention / terminal 压缩 / 稳定 retry semantic / source 单一权威）已完整且测试覆盖；已具备进入以下阶段的**工程条件**：

- terminal.send adapter 实现（真实 `Game.market`/terminal 调用仍需独立评审）；
- 纯 contract plan shadow（零 Game 写）；
- authorization shadow / next-tick reconciliation shadow；
- 零 Game API 调用的端到端演练。

真实 Game API 调用不得仅因单元测试通过而批准——需 shadow 阶段的独立证据。
