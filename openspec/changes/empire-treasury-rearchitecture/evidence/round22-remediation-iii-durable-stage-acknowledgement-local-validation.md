# Round 22 Remediation III — Durable Stage Acknowledgement 本地验证

- 日期：2026-09-03
- 分支：`refactor/empire-treasury-rearchitecture`
- 预期起始 HEAD：`b1f2e2c9c5786372e66f336bab4b18c0beddf83a`
- 实际起始 HEAD：`b1f2e2c9c5786372e66f336bab4b18c0beddf83a`（与远端一致，无前移）
- 最终代码/测试验证 HEAD：`e31e5cac895f929d6e2df0a3536e053c4946ba4a`
- 最终分支 HEAD：见本文档末尾（evidence/budget 提交后）

## 本轮 commits

| SHA | 作用 |
|---|---|
| `c638a15` | fix(treasury): require durable acknowledgement for every cleanup stage——ack/activation/opposite/coordinator/stageHandlers 五个新模块 + journal/facade/faultResolution/resolutionAuthority/resolutionStore/lineageRetirementSummary/receipts 迁移 + API cleanup 报告 + 架构守卫 |
| `114201f` | test(treasury): cover cleanup acknowledgements and opposite proof blockers——treasuryRound22RemediationIII（28 tests） |
| （后续）`docs(openspec)` | 本 evidence + tasks/proposal 更新 |
| （后续）`chore(test-budget)` | budget 锚点更新 |

## 原始缺陷的确定性复现（修复前 → 修复后）

| # | 原始缺陷 | 复现测试（treasuryRound22RemediationIII） | 修复前 | 修复后 |
|---|---|---|---|---|
| 1 | `markTreasuryResolutionCleanupStage` 结果可能被忽略 | "marker discharge 成功但 journal marker stage 写失败"（fault injector `write_rejected`） | boolean 被调用方忽略，阶段与外部事实脱节 | `ack.outcome === "write_rejected"`；Authority 保留；advance 停在 marker_discharge；tombstone 保持 resolving |
| 2 | 阶段写入后无 read-back | "read-back 布尔被回滚" / "identity 被篡改"（injector `revert_stage` / `tamper_identity`） | 写入即认为成功 | `read_back_failed`；Authority 保留 |
| 3 | marker 已清但 journal 未确认时可能释放 Authority | 同 #1 | release 照常执行 | authority ack 前置 marker ack（偏序硬门禁） |
| 4 | not-executed converge 后 outcome/lineage/journal 删除无硬门禁 | "final tombstone 写成功但 outcome stage 写失败" | mark 被忽略 | outcome `write_rejected` → lineage `blocked`（偏序）→ journal entry 保留 |
| 5 | committed lineage close 失败仍返回宽泛 resolved | API cleanup 报告 + coordinator pendingStage | resolved 谎称完成 | cleanup.stage=fully_complete 仅在删除 read-back 后；否则 lineage_pending/journal_completion_pending |
| 6 | replay-readable Receipt 完成 destructive release | "无关 Receipt entry 损坏"（fresh-global 首读） | 单键读取容忍损坏 → 释放 | coordinator 前置 trusted：store_unhealthy → 零 marker 清除/零释放/零 finalize |
| 7 | activation 仅按 transaction ID | "reservation + tombstone 不存在" / "digest 冲突" / 四维表驱动 | activate 返回 true 即 durable | proof_absent / identity_conflict 七类结果；零后续 destructive |
| 8 | 相反 proof 身份不足被当作 absent | "insufficient not-executed tombstone" / "legacy committed Receipt" | 折叠为 absent 放行 | insufficient/legacy 均阻断（四分类） |
| 9 | 三条路径并行 destructive 编排 | 架构守卫（treasuryWriteArchitecture） | 多套顺序并存 | 唯一 coordinator advance；journal 恢复经 driver；架构扫描强制 |

## Cleanup acknowledgement 状态图

```
settlement proof activation ack（七结果：activated / already_activated / absent /
  proof_absent / identity_conflict / proof_insufficient / store_unhealthy / read_back_failed）
  └─ marker discharge ack（discharge read-back → 阶段写入 → journal read-back；
     committed 前置 release-trusted Receipt：损坏/conflict/legacy 不足 → 零清除）
      └─ authority release ack（handler：resolver → release → read-back not_found → 阶段 read-back）
          └─ outcome finalization ack（committed：trusted + 相反 proof + verifier +
             resolving→final 写入；not-executed：converge 驱动 exact proof + opposite 检查）
              └─ lineage finalization ack（tr1_ chain close trusted 验证 / root converge /
                 initial not_applicable——同一结构化接口）
                  └─ journal completion ack（五布尔 read-back 全 true → 删除 →
                     Memory read-back absent → fully_complete；否则 cleanup_pending）
任一阶段非 acknowledged/already_acknowledged → 停止；entry 与外部 proof 保留。
```

## Proof activation 矩阵

| 场景 | 结果 |
|---|---|
| matching final not-executed tombstone | activated（+ read-back 确认；幂等 already_activated） |
| matching resolving committed tombstone | already_activated（幂等复验成立） |
| tombstone 不存在 | proof_absent（保持 pending） |
| digest / contract / cohort / durable / lowlevel 任一不同 | identity_conflict |
| resolution 相反 | identity_conflict |
| resolution store unhealthy | store_unhealthy |
| global reset 后 proof 存在 / 不存在 | 幂等补激活 / 不自动激活 |

## Opposite proof 矩阵

| 目标 | 阻断源 | 四分类 |
|---|---|---|
| committed | final not-executed tombstone | exact_match / identity_conflict / insufficient / store_unhealthy |
| committed | GRA proof（byAttempt） | exact_match / identity_conflict / insufficient / store_unhealthy |
| not-executed | trusted committed Receipt | trusted_proof / identity_conflict / insufficient(legacy) / store_unhealthy——只有 absent 放行 |
| not-executed | resolving/final committed tombstone | exact_match / identity_conflict / insufficient / store_unhealthy |

## 验证命令与结果（最终代码 HEAD `e31e5ca`）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 通过（0 errors） |
| `npm run build` | 通过；bundle sha256 `ce803b766a3447e51a89a25a41832e80fb508113606115994261b0784efbd1e6` |
| Treasury 定向（MarkerDischarge + Remediation I/II/III） | 4 suites / 115 tests 全过 |
| Treasury 全量 `npx jest src/runtime/treasury/` | 68 suites / 1251 tests 全过 |
| 全仓 `npx jest --config jest.config.cjs` | 264 suites / 2014 tests 全过 |
| `node scripts/verify-jest-budget.mjs` | 通过（budget 更新后） |
| `git diff --check` | 干净 |

最终计数：suites=264，tests=2014，passed=2014，failed=0，pending=0，todo=0，skipped=0。

## GitHub CI 实际状态

仓库无 `.github/workflows/` 配置、无任何 Actions 运行记录——本轮只报告本地验证，不声称 CI passed。

## 边界声明

- 未部署到 Screeps；未合并 main；未调用真实 `terminal.send()`；未调用真实 Game 写 API（测试全部 mock）；不涉及 market/lab/factory/nuker 等经济 writer。
- Screeps hard CPU interruption 与 Memory flush 仍不构成 exactly-once 保证（journal read-back 缩小窗口但不消除引擎级中断）。
- 遗留运营风险：cleanup journal 硬容量 256、GRA/summary 容量仍为有界运营约束；上轮起的 forensic 遗留语义不变。
