# Round 22 Remediation X — Ticket-Gated Attempt Opening, Namespace-Scoped Anti-Reuse, Health-Complete Lifecycle GC & Exact GRA Replacement（本地验证证据）

## 1. 日期、仓库、分支、实际起始 HEAD

- 日期：2026-09-03
- 仓库：ceyirelehe47/screeps-bot（本地 D:\code\screeps\screeps-bot）
- 分支：refactor/empire-treasury-rearchitecture
- 实际起始 HEAD：`70789b337abf5362fc35fb80c11c625a9b3e966f`（与任务书预期一致；`e28df92` 之上只有 evidence/docs 与 budget 提交，无未验证生产代码）

## 2. 最终代码/测试验证 HEAD

`d5f69f230d671e04238927cc1bf9208abaddcea3`（全部定向/Treasury/Defense/全仓验证在该 HEAD 执行；evidence 与 budget 提交在其后，只新增文档与预算文件）

## 3. 最终分支 HEAD

见第 20 节 push 结果（evidence/budget 提交后的分支 HEAD）。

## 4. commit 清单及职责

| commit | 职责 |
|---|---|
| `f3d4d41` | fix(treasury): gate initial attempt execution on issued ticket handoff——ticket gate（prepare 层 + contract binding）+ 原子 handoff + resolver exclude 选项 + VII/VIII/IX fixture 迁移 |
| `0cb599d` | fix(treasury): scope anti-reuse frontiers by issuer namespace——retired range v2（namespace 隔离 + v1→v2 严格证明迁移/fail closed）+ relation 域维度 + coalesce current-only |
| `97da9fb` | fix(treasury): make lifecycle ownership health-complete——Intent/Quarantine ensure 前置、settled receipt 整店 health、summary probe 未装配 fail closed |
| `3a848b4` | fix(treasury): require exact gra replacement and bound ticket storage——GRA exact replacement verifier + 依赖关闭 + 双索引维护 + ticket 总容量 128 |
| `10d69fb` | test(treasury): cover remediation x lifecycle counterexamples——T1-T12 / B1-B8 / N1-N10 / H1-H10 / G1-G12 + 压力（45 项新测试） |
| `d5f69f2` | test(treasury): enforce ticket and namespace lifecycle architecture——架构守护 12 项 |
| （后续） | docs(openspec): record remediation x local validation；chore(test): update verified remediation x budget |

## 5. production ticket opening 的实际状态顺序

```
openTreasuryIssuedInitialAttempt(owner)
  → mint（watermark 推进）+ ticket 写入 + read-back（原子——失败回滚 watermark）
  → active(unbound)
execute 链（contract：open→build→authorize→execute）：
  prepareTransaction → 既有 replay blocker（settled/quarantine/tombstone/
    lineage/summary/durableSettlement）之后 ticket gate（无 ticket/expired/
    consumed-without-owner/durable-owner-in-place → 拒绝）
  → binding gate（AC4 contract digest 写入 ticket + read-back；幂等/冲突）
  → redemption → admission → durable intent 写入 + read-back
  → execution-started 持久化（executing intent = durable owner）
  → 【handoff consume】active → consumed（+read-back）
  → Game callback 恰好一次 → commit/abort
```

统一 consume 规则：`completeTreasuryIssuedTicketHandoff` 在 durable owner（统一
resolver 判定，exclude ticket 自身与瞬态预留）在位时才 consume——纯前置失败
（authorization/epoch/capacity）与完整回滚的 abort 保持 active（同 exact
opening 幂等重试）；writeFault/quarantine/intent 残留等 uncertain 终态在位
→ consume（同 ID 不可再执行）。

## 6. 每个 global reset 中断窗口的恢复结果（X4 / T8 / G12 / N7 实测）

| 窗口 | 恢复结果 |
|---|---|
| issuer v1→v2 迁移写入后 | reset 后 health healthy、watermark=0、legacy watermark=100（迁移幂等） |
| active ticket 写入后 | ticket 从 Memory 恢复（active） |
| durable owner（in-flight intent）写入后、ticket cleanup 前 | gate 的 durable-owner 分支幂等 consume（handoff_recovered）+ callback 恒 0；重复完成 consumed 幂等 |
| replacement summary 写入后、旧 GRA 删除前 | reset 后 summary 与 GRA 均可读（authority 不丢）；满载驱逐重跑 relation 再验证（幂等完成或保守保留） |
| namespace range migration 写入后（v1→v2） | 二次 load 幂等（区间不变、无双 frontier、旧 blocker 保留） |

## 7. direct mint 无 ticket 的 runtime 拒绝证据（T1）

`mintTreasuryInitialAttemptId` 产出 checksum 合法且 `checkTreasuryService
IssuedAttemptId().status === "issued"` 的 ID，sealed production execute 返回
`prepare_rejected / issued_ticket_missing`，callback=0。

## 8. expired/GC ticket 重放拒绝证据（T3/B8）

open 后 TTL+1 → GC（expire 1 条 + retire 删除）→ 新 tick 重建 fresh
contract execute → `issued_ticket_missing`，callback=0；B8 三阶段（active/
handoff-pair/terminal cleanup）reset 交错后全部旧 ID callback=0。

## 9. legacy/current namespace 隔离方式

- 区间绑定 `namespace: "legacy" | "current"`（v2 store；同域内单调合并、
  域间互不影响；排序 current 在前）；
- 查询按 ID 自带前缀 parse 的 namespace 匹配区间；
- absorb/guard/coalesce/historical 压缩全部携带发行域（coalesce 仅 current
  域——legacy canonical ID 不可重建）；
- summary↔certificate relation 与 GRA↔summary relation 均含 issuer domain
  显式维度（同序号跨域 conflict）。

## 10. bare-sequence range 迁移方式及不可证明时的 fail-closed 行为（N6）

严格证明链（版本边界）：
- issuer v1 在位 → ti2_ 未诞生 → 全部归 legacy；
- issuer v2 无 legacy record → 从未有 ti1_ → 全部归 current；
- issuer v2 + legacy record 且 v1 range.updatedAt < migratedAtTick → ti2_
  absorb 不可能发生 → 全部归 legacy；
- 否则（可能混合且区间合并后不可拆分）→ **forensic fail closed**：store
  保持 v1 原样、health unhealthy、structured 查询 store_unhealthy、absorb
  rejected（N6 实测 detail 含"不可证明"）。

## 11. lifecycle owner health matrix

| source | fatal/损坏时行为 | 测试 |
|---|---|---|
| issued ticket | health 前置 → owned+unhealthy | H4 |
| admission reservation（heap） | 无 store（瞬态——gate 恢复判定排除） | — |
| headroom reservation | health 前置 → owned+unhealthy | 既有 |
| durable Intent | ensure 触发 load 全量校验（含 unrelated entry）→ owned+unhealthy | H1/H2 |
| Quarantine | ensure 同上 | H3 |
| cleanup journal | health 前置（IX 既有） | 既有 |
| authorization fault / write-fault marker | health 前置（IX 既有） | 既有 |
| resolution tombstone / lineage | probe + health（未装配 owned） | H5 |
| live completion / historical | 内建 tri-state（conflict → owned active） | H10 |
| settled receipt | **整店** heap fatal → owned+unhealthy（新增） | H 组 |
| GRA / summary | probe + health；**summary probe 未装配 → owned+unhealthy（新增）** | H5 |
| malformed range（resolver 消费） | structured 非 absent → 阻断 abandon | H10/N8 |

## 12. GRA ↔ summary exact replacement 比较维度

root transaction ID / lineage ID / root issuer domain / generation=0 / 
retirement outcome 相容（root-only chain_committed 与 not-executed proof 矛盾）/
proof class（authorityClass）/ identity profile（rootExact 现场推导）/
digest / canonical root identity（五元合成）/ durable identity /
contract+cohort+lowlevel 按 class 矩阵 / summary schemaVersion=3
（legacy replay-only 不授权）/ exact 依赖关闭（cleanup journal +
resolution tombstone + active lineage，全 health-complete）。

## 13. legacy summary 为何不能授权 destructive eviction

GRA 驱逐 probe 只返回 modern-only 视图（schemaVersion === 3——v2 legacy
archive 回落被过滤）；verifier 的第一维度即 schema 检查。v2 summary 无
exact identity（不可补造），授权驱逐会让 GRA 的 exact retirement 语义失去
承接者。

## 14. ticket store 真实 hard capacity

- 总 entry 上限 `TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES = 128`（shape
  validator 强制——超容量 store unhealthy，B1）；
- active 并发上限 64（满载阻断新 issuance，不删 active）；
- open 的总容量检查在 mint 之前：满载先有界回收 eligible terminal（与 GC
  同一 retire 路径，watermark frontier 验证），仍满 → fail closed 且
  watermark 不推进（B4）。

## 15. 高吞吐下最大 ticket entryCount（实测）

- **真实 execute 路径**（30 tick × 每 tick 12 个 open→execute→consumed，
  单 tick 转换量 12 > GC batch 8）：ticket store **maxEntryCount = 12**，
  远低于 128 上限（每 tick beginTick GC 回收，稳态残留 ≤ 单 tick 产生量）；
- abandon 高吞吐（B2：50 tick × 20 个 open→abandon + 周期 GC）：全程
  entryCount 恒 ≤ 128（单条 abandon 即时走 expire→retire 完整路径删除）。

## 16. ≥600 chain 后各 store 最大 entryCount（X1 实测，真实 converge+compact 全链路）

| 阶段 | treasury Memory 字节 | summary | certificate | retired range | GRA | tombstones |
|---|---|---|---|---|---|---|
| 300 chain | 386,487 | 128（顶格） | 256（顶格） | 1（单区间收敛） | 255 | 255 |
| 600 chain | 364,429 | 128 | 256 | 1 | 230 | 230 |

（tombstone 惰性退休 + GRA 联动释放使 GRA/tombstone 在 256 容量内稳态震荡；
600 阶段 Memory 反而小于 300 阶段——retention 退休与区间压缩收敛。）

## 17. 300/600 阶段 Treasury Memory 序列化字节数

386,487（300）→ 364,429（600）：非线性增长（下降——长期运行收敛）。
ticket 高吞吐段（consumed 路径）treasury 分支长度 19,845 → 67,138：增长
来自 360 个 committed attempt 的 receipt/tombstone retention 窗口内正常
积累（ticket store 本身 entryCount 平台 12）。

## 18. T/N/H/G/B 固定反例到测试名映射

| 编号 | 测试（文件.it 名前缀） |
|---|---|
| T1-T12 | treasuryRound22RemediationX.test.ts："T1：直接 mint…" ~ "T12：ticket owner/source/contract binding 不一致…"（12 项） |
| B1-B8 | treasuryRound22RemediationX.test.ts："B1：手写超过 hardCapacity…" ~ "B8：global reset 交错…"（8 项） |
| N1-N10 | treasuryRound22RemediationXNamespace.test.ts："N1：v1 range [1,100]…" ~ "N9：historical completion 压缩…"（N4/N10、合并项共 9 个 it 覆盖 10 编号） |
| H1-H10 | treasuryRound22RemediationXNamespace.test.ts："H1：Intent store…" ~ "H10：conflict/insufficient/malformed…"（10 项） |
| G1-G12 | treasuryRound22RemediationXNamespace.test.ts："G1-G6：verifyTreasuryGeneration… "（维度单测）+ "G7/G10：满载+全部 proof 被 tombstone 依赖…" + "G8/G9/G11/G12：eligible…"（3 个 it 覆盖 12 编号） |
| 压力 | 同文件："X1：≥600 条现代 terminal chain…"、"X2：ticket 高吞吐…"、"X3：namespace 并存…"、"X4：global reset 五窗口…" |

## 19. 定向 Jest 精确数字

- X 定向（X 两文件 + IX + lifecycle contract）：4 suites / 109 tests / 109 passed / 0 failed / 0 pending / 0 todo
- 相关定向（treasuryActionContract + treasuryCore + treasuryWriteArchitecture）：3 suites / 93 tests / 93 passed
- 相关定向（durableIntent + quarantine + generationRetention + exactRetirement + r21Lifecycle + markerDischarge + safeExecute）：7 suites / 147 tests / 147 passed

## 20-21. Treasury 全目录 / Defense 冻结回归精确数字

- Treasury 全目录：**77 suites / 1535 tests / 1535 passed / 0 failed / 0 pending / 0 todo**
- Defense 冻结回归 + 全仓（一次执行同时覆盖）：全仓 **279 suites / 2373 tests / 2373 passed / 0 failed / 0 pending / 0 todo**——其中 Defense 侧（defenseGlobalRampartFootprints / defensePreallocationRampartOwnership / defenseStationaryRampartOwnership / defenseAllActorReservation / defenseFallbackReallocation / defenseFocusFire / defenseFocusFireStateful / homeDefense / towerControl / homeDefender / memoryDeclarationBoundaries）全部包含且通过；本轮 Defense 生产代码零修改（架构守护 X12 源码级确认）。

## 23. typecheck/build 结果

- `npx tsc --noEmit -p tsconfig.json`：exit 0（零错误）
- `npm run build`：exit 0（dist/main.js 构建成功，42.8s）

## 24. bundle SHA-256

`cc1ff5e18a333854e4b7dfb64e491608f68fd219957120403fedc0ed091014fb`（dist/main.js）

## 25. 声明

- 未部署到 Screeps（未调用真实 screeps API 上传）；
- 全部 Game 写动作测试使用 mock/spy（installRooms 测试房间 + jest.fn callback）；
- 未调用真实 terminal.send() / Game.market / lab / factory / nuker / carrier；
- 本文件全部数字为本地真实执行结果（非预计值）；GitHub 无独立 CI，以上为 Agent 本地 Jest/构建验证，不是 CI。

## 附：验证 HEAD 纪律说明

全量验证在 `d5f69f2` 完成后，只新增本 evidence 文档与 design/proposal/budget 更新（无生产代码/测试/配置/类型变更）。临时探针（_probeEvidence/_probeTicket/_probeTicket2.test.ts）已全部删除，工作树干净。
