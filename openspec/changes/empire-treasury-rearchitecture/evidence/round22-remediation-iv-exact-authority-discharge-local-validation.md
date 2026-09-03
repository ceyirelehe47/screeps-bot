# Round 22 Remediation IV — Exact Authority Discharge（本地验证证据）

- 日期：2026-09-03
- 分支：`refactor/empire-treasury-rearchitecture`
- 预期起始 HEAD：`a4bcbe8336e265ffcb53425de95caa6f8fa830f0`
- 实际起始 HEAD：`a4bcbe8336e265ffcb53425de95caa6f8fa830f0`（一致；远端同步、工作树干净）
- 最终代码/测试验证 HEAD：`91a11f5cc59df0b710db832e096602ad9f5b378f`
- 最终分支 HEAD：见本文件所在 commit（其后仅允许纯文档/budget 差异）

## Commits（本轮全部）

| SHA | 作用 |
| --- | --- |
| `8f9eafa` | fix(treasury): verify exact authority and opposite proofs before discharge（pre-release gate / exact discharge / lineage finalization proof / opposite GRA relation / coordinator gate 前移 / ack expected 移除） |
| `984bca5` | fix(treasury): distinguish cleanup completion from missing journal authority（completion authority / journal open-admission 分离 / candidate 写入前后验证 / child 接管回收） |
| `2e749fa` | test(treasury): align fixtures with pre-release gate and completion authority |
| `8338f1b` | fix(treasury): read not-executed proof via assembled probes in gate（resolutionStore 环依赖修复） |
| `5b4e603` | test(treasury): cover exact discharge completion and lineage failures（新 suite，27 tests） |
| `91a11f5` | test(memory): update runtime schema fingerprint for engagement revision（Defense 侧字段联动，见 Defense evidence） |

## Treasury pre-release gate 矩阵（六.7）

gate 在 marker discharge 与 Authority release 之前按序验证：
journal exact identity → target settlement proof → opposite proof absence →
semantic lineage purpose（tr1_）→ 当前 Authority exact identity。结果分类：

| 场景 | gate 结果 | 实测 |
| --- | --- | --- |
| journal↔authority 全 match | `verified` | RemediationIV-1/2（多场景） |
| marker ack 后 authority 全 absent（生产中断窗口） | `authority_absent_recoverable` | RemediationIV-1「已释放中断窗口」 |
| journal 幂等补开 + 外部 marker absent（遗留窗口） | `authority_absent_recoverable`（幂等补完成） | Round16「marker 不存在」 |
| authority absent 但 marker 仍存在 | `authority_absent_unexpected`（顺序破坏阻断） | RemediationIV-1 / Round16 / LowlevelProvenance |
| journal 身份非法 | `journal_identity_insufficient` | 构造层拒绝（open candidate 验证） |

## Authority 来源与 exact relation 矩阵（六.3/七）

| 来源 | 比较维度 | 冲突行为 | 实测 |
| --- | --- | --- | --- |
| Intent（单/双） | treasuryExactAttemptIdentityOfAuthority 全维度（digest/proofClass/contract/cohort/durable/lowlevel/lineage 四字段） | conflict → 零删除 | RemediationIV-1「Intent 身份冲突」（digest/durable 不同） |
| Quarantine | 同上 | conflict → 不 release | RemediationIV-1（写入层拒绝同 id 异身份） |
| Intent+Quarantine 双存在 | resolver 完整 cohesion（既有）后 authority exact relation | inconsistent → 零 destructive | resolver 既有矩阵 |
| Authorization Fault | authorityLevel→proofClass 显式定级 + digest/contract/cohort/durable/lowlevel（不再只比 digest） | conflict/insufficient → 不删除 | RemediationIV-1「Fault 仅 digest 相同」「Fault 完整 match→release+read-back」 |
| release 后 read-back | resolver 必须 not_found（fault 必须 absent） | 非 not_found → authority 不得 ack | RemediationII-6 spy 矩阵（调用序 6 处伪造） |

## Opposite proof 在 release 前的顺序（六.6）

coordinator 阶段 0.5（marker discharge 之前）执行 gate 的 opposite 检查；
authorityRelease handler 内部再次执行（双前移）。blocker 分类：committed
目标 ← final not-executed tombstone / GRA（match、conflict、insufficient）/
store unhealthy；not-executed 目标 ← trusted committed receipt / resolving-
final committed tombstone / store unhealthy。实测：RemediationIV-2 全矩阵
（matching GRA → `opposite_proof_match` 且 marker 未清、authority 未释放；
conflicting/insufficient 同阻断；trusted receipt 阻断；store unhealthy 零
destructive）。

## GRA exact relation（八）

outcome 快捷路径（transactionId+digest）已删除。三方比较（journal ↔
final tombstone ↔ proof）：rootTransactionId / rootIdentityDigest（active
record 或 terminal summary 权威解析）/ lineageId / generation /
transactionId / parent+binding（gen≥1 三方）/ proofClass 三方 / digest
三方 / contract/cohort/durable/lowlevel 三方 / resolution=not_executed /
retirement 三段全 true。conflict 实测：generation 维度（identity 视图）
与 byAttempt 异 (lineage,generation) 冲突检测；complete match → outcome
ack（RemediationIV-5 全链 completed）。GRA opposite blocker 升级为完整
exact identity relation（oppositeProofMatrix——authorityClass 缺失 →
insufficient ≠ absent）。

## Active/terminal lineage 判定（九）

| 状态 | 行为 | 实测 |
| --- | --- | --- |
| active record 存在 | exact 匹配 + 状态机（既有） | RemediationIII 回归 |
| active 缺失 + matching terminal summary | `already_final`（finalExact 完整 match + finalAttemptId/finalGeneration/terminalState 一致） | lineageFinalizationProof 实现 + 回归 |
| 两者都缺（现代 profile root not-executed） | `lineage_missing` blocked（不得 not_applicable） | RemediationIV-4 |
| 两者都缺（committed initial / 隔离 profile） | `not_applicable` | RemediationIV-4「initial committed」 |
| 任一 store unhealthy | 零阶段推进 | 实现层 health 探测 |

## Completion authority 状态图（十）

```
全部 journal 阶段 ack
  → completion candidate 写入
  → Memory read-back + exact identity 重新验证
  → 删除 journal entry
  → journal 删除 read-back absent
  → fully complete
（completion 写入失败 → journal 保留 pending；
 journal 删除失败 → completion 存在、下 tick 幂等重删）
journal absent + completion match      → completed（global reset 幂等）
journal absent + completion absent     → no_cleanup_authority（fail closed）
journal absent + completion 冲突       → blocked（conflict）
容量满载                               → fail closed（不驱逐、不覆盖）
child 接管                             → 释放 parent completion（容量回收）
```
实测：RemediationIV-5 全矩阵（含 300 代链容量回收——Round19OperationCount
「300 代 chain」通过）。

## Journal open/activation 流程（十一）

open（admission）→ acknowledge settlement proof（activation 权威）→
marker → authority → outcome → lineage → completion。open 不再自动激活
reservation（`already_open_reservation` / `already_open_activated` 细分）；
candidate 写入前完整验证（profile 矩阵 / lineage 四字段整体性）+ 写入后
单 key read-back（entryCount/store shape 一致）。state-changing ack 移除
可选 expected——journal entry 唯一 expected 来源（heap↔Memory 完整 11
字段自洽比较）。

## Operation-count（十九节 Treasury 部分）

- 50 次 pre-release gate：verified 稳定、无全 store 扫描（单 key 查询；
  RemediationIV-7）；
- 50 次 completion lookup：单 key O(1)（RemediationIV-7）；
- 空闲 beginTick O(1) 快路径（Round16/19 回归保持）。

## 实际验证命令与结果（全部在验证 HEAD `91a11f5` 执行）

```
npx tsc --noEmit -p tsconfig.json                 → 通过（零错误）
npm run build                                     → 通过；dist/main.js
  bundle sha256: 7eae44affd9a3e53911c44bf4743f2511db8add2a1f9d07476f0c2ace4b12ede
npx jest --config jest.config.cjs \
  src/runtime/treasury/treasuryRound22MarkerDischarge.test.ts \
  src/runtime/treasury/treasuryRound22Remediation.test.ts \
  src/runtime/treasury/treasuryRound22RemediationII.test.ts \
  src/runtime/treasury/treasuryRound22RemediationIII.test.ts \
  src/runtime/treasury/treasuryRound22RemediationIV.test.ts
                                                  → 5 suites / 142 tests / 142 passed
npx jest --config jest.config.cjs src/runtime/treasury/
                                                  → 69 suites / 1278 tests / 1278 passed
npx jest --config jest.config.cjs                 → 266 suites / 2067 tests / 2067 passed
（全量含 Defense 定向与声明边界——见 Defense evidence）
```

- Suites：266；Tests：2067；passed：2067；failed：0；pending：0；todo：0；
  skipped：0（jest 输出无 skipped 计数项；无 fit/skip 调用）。
- CI：本仓库无独立 CI 配置——以上全部为本地验证，不声称 CI passed。

## 边界声明

- 未部署到 Screeps；未合并 main；未调用真实 `terminal.send()`；未调用
  Game.market / lab / factory / nuker 或任何真实经济 writer；测试全部
  mock/持久 store 写入 API。
- Treasury 生产路径无任何真实 Game 写 API 新入口（gate/discharge/
  completion 只操作 Memory 持久 store）。
- Screeps hard CPU interruption 与 Memory flush 仍不构成 exactly-once
  保证——本轮的全部写入顺序与 read-back 协议以持久事实为权威、以结构化
  pending 为恢复语义。

## 剩余风险

- cleanup completion / GRA / tombstone / summary 各 store 硬容量（256/384/
  128 等）在极端长链或 forensic 累积下仍会 fail closed（需要运营处理，
  不自动驱逐）；
- legacy（legacy-replay / forensic-isolated）与 forensic 轨道的清理仍需
  显式运营决策；
- authority absent + marker 残留（旧顺序遗留形状）现在结构化阻断——若
  历史数据出现该形态需要人工/forensic 处理（不自动修复）。
