# Round 15 — Resolution State Monotonicity & Cross-Store Authority Release（本地验证证据）

- 日期：2026-08-31
- 分支：`refactor/empire-treasury-rearchitecture`
- 起始 HEAD：`cf8b71dd53ab3650cb456f7789cfcc57505f3532`（Round 14 终态，budget 锚点 e740fb2）
- 最终 HEAD（实现与测试）：`a04c4ee`（本 evidence 提交与 budget 提交随后）
- 验证环境：本地 Windows（Git Bash）+ Node + Jest；**GitHub 无 CI——以下全部为真实执行的本地验证**

## 一、commit 列表（cf8b71d..a04c4ee）

| SHA | 作用 |
|---|---|
| a3cb246 | docs(openspec): define round 15 resolution monotonicity and cross-store release（proposal/design 第 11 节/spec 10 个 Requirement/tasks 第 21 节） |
| 6dffd03 | refactor(treasury): add round 15 narrow-responsibility authority modules（resolutionStateMachine / committedProofVerifier / authorityIdempotence / forensicProvenance / durableSnapshot 五个窄职责模块） |
| 6903d93 | refactor(treasury): enforce resolution state machine, unified recovery and v5 store（resolutions v5、写入口状态机、recoverStagedResolutions 统一 resolver、health 版本兼容 + inProgress 缓存） |
| 87cb8d8 | refactor(treasury): store-specific publication validation and controlled lowlevel provenance（durablePublication 语义注入 + 比较字段补齐；lowlevelSource 受控枚举） |
| 115a944 | refactor(treasury): authority-class idempotence and closed store snapshots（三 store class 幂等 + authorizationFaults 回滚修复 + intent→quarantine 转移视图归一化 + 深冻结读取） |
| f34ff97 | fix(treasury): gate reconciliation on tombstones and share committed verifier（capability gate + immediate 路径复用三方 verifier + readiness 缓存 blocker + 既有测试适配） |
| e621370 | fix(treasury): resolve authority before receipt refresh and gate on identity first（recovery 中 resolver 前移：inconsistent 零 refresh；gate identity conflict 优先；test-only 注入点） |
| a04c4ee | test(treasury): cover round 15 state and authority invariants（3 个新测试文件 / 64 用例） |

## 二、Resolution 状态迁移图（resolutions v5）

```text
absent ──create──▶ resolving committed ──finalize(保 identity/结论)──▶ final committed
   │
   └────────create────────▶ final not-executed

禁止：resolving committed → final not-executed / resolving not-executed；
      final committed ↔ final not-executed；final → resolving；
      同 ID 改 digest / resolution kind / proofLevel / attempt identity /
      actionTick / observationTick / reconcilerKind / source / forensic
      provenance；settledAtTick 变化；resolvedAtTick 降低（final 幂等重复写
      要求 resolvedAtTick 亦完全一致）
幂等：resolving/resolving 与 final/final 的全部安全关键字段完全一致重复写 →
      idempotent（非覆盖写）；任一差异 → rejected 且原数据逐字段不变
删除：仅允许 resolving 回滚（final 不可删除；retention 清理走独立 evict 通道）
```

## 三、Cross-store authority 状态图（统一 resolver）

```text
resolveTreasuryUnresolvedAuthority(tx)  ← recovery 在 receipt 读取/refresh 之前调用
  ├─ not_found ─▶ committed：仍须 receipt↔tombstone match + tick 足够才补完成 finalize
  │                not-executed：视为释放已完成（跳过，不伪造 authority）
  ├─ ok(normalized) ─▶ 三方 verifier（tombstone + authority + 持久 receipt proof）
  └─ inconsistent ─▶ 零副作用：intent 保留 / quarantine 保留 / tombstone 保持
                      resolving / marker 保留 / authorityInconsistent 独立计数 /
                      write readiness 阻断 / 零 refresh / 零 stage 变量
旁路删除确认：`readQuarantine ?? readIntent` 不再存在于任何恢复路径
```

## 四、Forensic 自动 / 显式路径区别

| 路径 | provenance | 普通 beginTick 自动恢复 |
|---|---|---|
| migration-derived forensic（v3 partial 迁移 / 防御直写 / 旧任意 lowlevel source 迁移） | 无 | **永不释放**（proof level 自动释放矩阵阻断，计入 insufficient） |
| explicit forensic management | 显式 `forensicProvenance`（协议/acknowledgement/管理身份/attempt/确认时间/来源/自动补完成许可，形状校验全显式） | 本轮未实现完整显式流程——一律保持隔离（诊断保留 reason/detail 来源） |
| legacy proof | —（replay blocker 语义保留） | **不释放任何等级 authority**（矩阵收敛：identity-bound→modern、lowlevel→lowlevel 仅此两条） |

## 五、Authority class 幂等矩阵（authorityIdempotence.ts 唯一权威）

| class | same 判定（全部成立） | 任一不成立 |
|---|---|---|
| 公共前置 | transactionId/digest/kind/actionKind/canonical postings/source/faultTick 相等 | conflict |
| modern | + level 相同；durable 双方完整且相等；cohort digest 双方完整且相等；contractId/contractDigest 一致 | conflict / insufficient（durable、cohort 缺失） |
| lowlevel | + level 相同；受控 lowlevelSource 相同；durable 双方完整且相等 | conflict |
| legacy | + legacyV1 标记一致（完整受控 signature；**删除空对空通用幂等**） | conflict |
| forensic | + forensic reason 一致；已知 attempt facts 逐字段相等；outcome/phase 相等 | conflict / insufficient（provenance 缺失不视作 same） |
| 跨等级 | — | **永远 conflict** |

应用范围：intent / quarantine / authorization-fault 三 store 的 same-ID 写入（authorizationFaults 补齐既有 entry 身份重算，与另两 store 对齐）。

## 六、Publication read-back 验证矩阵

| store | 通用比较新增字段 | 注入的 store-specific 语义 validator |
|---|---|---|
| 全部 | phase、forensic（深比较）、legacyV1、faultTick、rollbackConfirmed、tick、recordedAt、createdAtTick、detail | — |
| intent | — | validateTreasuryIntentEntryShape（level 矩阵 / outcome-settlement 语义 / modern required / cohort / descriptor） |
| quarantine | — | validateTreasuryQuarantineEntryShape（phase/outcome/settlement 矩阵 / forensic provenance / legacyV1 / deltas / contract 事实）——检出"phase 被篡改但 digest 未变" |
| authorization-fault | — | validateFaultEntryShape（outcome 恒 not_started / rollbackConfirmed 恒 true / faultTick / detail 边界 / authority 矩阵） |

失败回滚恢复：entry、entryCount、revision、updatedAt（authorizationFaults 修复为恢复 previousUpdatedAt，不再错写 Game.time）。

## 七、Lowlevel provenance 受控权威

- 受控枚举：`runtime-lowlevel@v1` / `migrated-lowlevel@v1`（store 写入与 load 校验唯一集合）；`test-lowlevel@v1` 仅测试通道（production store 校验拒绝）。
- 未知任意字符串：写入拒绝 / unhealthy（fail closed）。
- runtime 来源只能由 store 内部写入路径缺省声明；migrated 只能由迁移定级生成。
- 旧任意 source 迁移：`classifyTreasuryAuthorityLevelForMigration` prior lowlevel + 无法证明来源 → **forensic 隔离**（不直接信任）。
- source 进入 lowlevel same-ID 比较（source 变化 → identity_conflict）。

## 八、Committed proof verifier 复用路径

唯一的 `verifyTreasuryCommittedResolutionProof({tombstone, authorityResolution, receiptProof})`（纯函数）被以下路径共同调用（模块级 spy 测试双命中证明）：

1. normal resolve-as-committed（immediate）：写 resolving → refresh → **重读持久 proof + 重新 resolver** → verifier → 通过才释放 → finalize；
2. beginTick staged recovery（resolving committed 分支）；
3. finalize 补完成（authority not_found 时 receipt↔tombstone match 许可）。

refresh 成功后 receipt 被篡改 / 双 authority 变 inconsistent / proof 变 legacy → 均不释放（authority 与 resolving tombstone 保留，独立计数与拒绝 reason）。

## 九、新增/升级 Memory store 版本、字段、容量与迁移

| store | 版本 | 变化 | 容量 |
|---|---|---|---|
| resolutions | v4 → **v5** | 新增可选 `forensicProvenance`（显式管理协议证明，形状校验：协议/acknowledgement/管理身份/attempt digest 族/confirmedAtTick/source/allowAutomaticCompletion） | 256 条 / retention 5000（不变） |
| intents / quarantine / authorizationFaults | v6 / v5 / v4（不变） | 无 schema 变化（本轮为语义校验升级：幂等矩阵、read-back 字段集、快照封闭） | 64 条（不变） |

迁移链：v1/v2/v3/v4 → v5（v4 无损标记；v3 按 proofLevel 定级：全身份→identity-bound、全缺→legacy、部分→forensic；v2→legacy；v1→final+legacy）；原子替换、幂等、损坏 fail closed 原数据保留。

## 十、operation-count 结果

- inconsistent 双 authority 恢复：intent/quarantine store fullScans **零增长**，resolution store 恰 +1（自身迭代）——不为单条 transaction 扫全 store；
- resolving capability gate：满表（256 条）resolution store 上签发路径 fullScans **零增长**（单条 tombstone 读取 O(1)），reconciler 未运行；
- store-specific read-back：既有 24 条历史 entry 的正常写入 fullScans **零增长**（read-back 只验证当前 entry）。

## 十一、真实验证命令与结果（本地执行）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（tsc -p tsconfig.json --noEmit 零错误） |
| `npm run build` | 通过（dist/main.js bundle sha256: 2b2f889e…；No deployment target set. Build only——**未部署**） |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | **37 suites / 765 tests / 765 passed / 0 failed** |
| `npx jest --config jest.config.cjs`（全量） | **231 suites / 1471 tests / 1471 passed / 0 failed** |
| `node scripts/verify-jest-budget.mjs` | 在 budget 提交后执行并记录（见下） |

定向测试覆盖：cross-store staged recovery / tombstone 状态机 / resolving capability gate / forensic provenance / class-specific idempotence / publication store-specific 语义 / deep snapshot / lowlevel provenance / immediate committed verifier / resolution v3 health / operation-count fixture（treasuryRound15ResolutionMonotonicity 31 + treasuryRound15AuthoritySemantics 30 + treasuryRound15OperationCount 3 = 64 新用例，全部通过）。

## 十二、预算（独立提交）

- 基线（Round 14）：228 suites / 1407 tests。
- 本轮终态：**231 suites / 1471 tests / 1471 passed / 0 failed**（+3 suites / +64 tests；未删除/跳过任何旧测试；既有 suites 仅按新语义适配断言，用例数不变）。
- `test/test-suite-budget.json` 与 `scripts/verify-jest-budget.mjs` 的 requiredBaselineCommit 在独立 budget 提交中指向含全部实现与测试的 `a04c4ee`（budget 提交的前一提交）。

## 十三、边界声明

- **未部署**（build only，无 deployment target）；
- **未合并 main**；
- **未接真实 writer**：以下生产文件自基线 cf8b71d 起零改动（git diff 为空）——resourceControl.ts / marketDirectContinuousAutomation.ts / marketSaleProtection.ts / marketSaleProtectionAdapter.ts / factoryControl.ts / synthesisControl.ts / nukerControl.ts / terminalActionEnergyOwnership.ts；production writer 边界扫描测试继续通过；本轮未调用 terminal.send / Game.market.deal / 任何 Game 写 API；
- GitHub 无 CI：以上均为本地真实执行结果，无 CI passed 声明；
- query/readiness 路径继续零 Game 写入（resolution store 不存在时零写探测）；
- **Screeps hard CPU interruption 与 Memory flush 边界仍不保证 exactly-once**——本轮的全部幂等/恢复协议将该窗口收敛为"可恢复的 staged 状态 + fail-closed 隔离"，不声称消除。

## 十四、遗留与后续

- forensic 显式管理流程（显式 provenance 签发与专用补完成入口）本轮未实现——全部 forensic proof 与 authority 保持永久隔离（提供诊断），进入下一轮的候选清单；
- 下一阶段准入判断（基于本轮终态）：resolution 单调性 / cross-store authority 释放 / proof 严格性已闭环，**具备进入 terminal.send adapter 设计与纯 contract plan shadow 的协议前提**；authorization shadow、next-tick reconciliation shadow、真实 terminal.send 调用仍须逐轮显式评审——真实 Game API 调用不得仅因单元测试通过而批准。
