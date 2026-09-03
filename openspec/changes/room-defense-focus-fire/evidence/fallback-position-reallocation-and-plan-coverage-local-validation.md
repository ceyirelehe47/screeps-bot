# Round 22 Remediation V — Fallback Position Reallocation & Plan Coverage（本地验证 evidence）

- 日期：2026-09-03
- 分支：`refactor/empire-treasury-rearchitecture`
- 实际起始 HEAD：`97e23e9ba67e0f6a31bd8e51ac42211f0c71e4b2`
- 最终代码/测试验证 HEAD：`f8cf544`（完整验证在此 HEAD 执行；其后的 OpenSpec/evidence/budget 提交不含生产代码、测试代码或类型代码）
- 验证环境：本地 Windows（无独立 CI）

## 提交清单（本轮 Defense）

| commit | 职责 |
| --- | --- |
| `fix(defense): reallocate fallback positions and close plan coverage` | fallback revision 房间级 per-defender 重新分配（unaffected 保留/占用排除/候选不足 hold/inside 重算）、plan 候选集合持久化、伤害分配路径统一唯一 Rampart 分配、canonical slot、缺 assignment 默认 hold、显式 not_participating、hold 不追逐 |
| `test(defense): cover fallback uniqueness and missing assignments` | defenseFallbackReallocation.test.ts（13 tests）+ memory 指纹锚点更新 |

## fallback 前后位置实例

固定反例 A（两 Defender 原位置不同、同 front 原目标 T1 失效，替代 boundary target T2 候选 r1(24,25)/r2(24,26)/r3(24,27)）：
- 旧行为（复制 target-level 单一位置）：slot 0 与 slot 1 都获得 T2 的 `engagement` 位置（同格争抢）；
- 新行为：revision 生成时房间级单次 `allocateDefenderRampartPositions`——slot 0 与 slot 1 获得**不同** revised position（如 (24,25) 与 (24,26)），per-slot mode=engage_position。

## 固定反例结果（全部通过）

- **A 两 Defender 不同 revised position**：`p0.position ≠ p1.position`（坐标键不等）；
- **B unaffected 位置保留**：d0（front 仅含 T2，原 target 有效）保留 plan 的原独立位置；d1（T1 失效 → fallback T2）获得的候选位置 ≠ d0 已占位置（rA 被 used 集合排除 → rB）；
- **C 候选少于 Defender**：单候选 + 两 Defender → 1 个 engage_position + 1 个 hold，全部 revised 坐标不重复；
- **D occupied candidate**：候选 `occupied: true` 被跳过（分配 free 候选 (24,27)）；
- **E inside target**：fallback 到 inside target 的 revision 不携带复制的位置（`position === undefined`、`positionKind === "inside"`）——消费方按当前可执行距离重算 action mode；
- **F Tower-first / Defender-first**：第二个请求 `fromCache=true` 且返回同一 revision 对象；
- **G 输入顺序反转**：Defender 输入反转后 per-slot 的 targetId 与 position 相同；
- **H 多房间隔离**：W1N57 与 W2N57 的 revision 互不影响（既有用例保持 + 新分配下通过）；
- **plan 候选集合持久化**：`plan.engagementCandidatesByTargetId.T2 = [r1, r2, r3]`（revision 消费持久化事实，不重查防线系统、不调 PathFinder）。

## 消费层（fresh plan 缺 assignment）

- **A slot 错配（RoleFactory slot="0"，plan entry 只有 creep name）**：fresh plan 存在 → hold（`attack`/`rangedAttack`/`moveTo` 均未调用）；
- **B fresh plan 显式 hold（targetId=null）**：继续 hold；
- **C fresh plan 显式 not_participating**：允许旧独立行为（attack 相邻 hostile 被调用）——显式字段，不是 entry 缺失；
- **D stale plan（plannedAtTick = Game.time - 1）**：保留旧独立 fallback（attack 被调用）；
- **E canonical slot 正常**：按 plan attack（`attack(h1)` 被调用，不回退独立评分）；
- 源头修复：planner 的 slot 只用 spawn config 最后段（`String(i)`）——configName 缺失的 defender 不入 plan（不再 creep.name 回落）；消费端 hold 语义对 slot 缺失/entry 缺失统一默认 hold；
- 候选不足的显式 hold（plan/revision 的 mode=hold）在 approach 距离下不再 moveTo 追逐边界外目标（消费端 `mode === "approach" && engagementMode === "hold"` 分支）。

## 确定性与 operation-count

- fallback revision 每房间每 tick 至多生成一次（多 consumer 读缓存——F 用例 fromCache 断言）；
- Rampart allocation 保持 O(Defenders × candidates) 有界稳定 greedy（primary→secondary→slot 字典序决胜——G 用例输入反转稳定）；
- planner 每房间每 tick 一次调用不变（`readFocusFirePlannerStatsForTest` 既有断言保持）；
- 不调用 PathFinder、不建立第二套防线模型、无 Game 写 API（纯函数 + Memory 计划逻辑）。

## 验证命令与精确结果（最终代码/测试 HEAD `f8cf544`）

| 命令 | 结果 |
| --- | --- |
| `npx jest src/runtime/defenseFocusFire.test.ts defenseFocusFireStateful defenseFrontAware defenseFallbackReallocation homeDefense towerControl(.scanThrottle) hostilePriorities src/roles/homeDefender.test.ts` | 9 suites / 110 tests / 110 passed / 0 failed |
| `npx jest test/memoryDeclarationBoundaries.test.ts` | 1 suite / 6 tests / 6 passed（指纹更新为 `0869b788491639af8630023a17dd387a37b7a5061b2d394ad323a9b59a86572f`） |
| `npx jest`（全仓） | 268 suites / 2115 tests / 2115 passed / 0 failed / 0 pending / 0 todo / 0 skipped |

新增测试：`defenseFallbackReallocation.test.ts` 13 tests（预算 13，high-risk）。

## CI / 部署边界

- 无独立 CI（全部为本地执行结果）；
- **未线上 canary**：fallback 重新分配与 hold 语义未经真实战斗环境验证；
- 未部署到 Screeps；测试未连接真实游戏环境（全部现有 mock/fixture）；Tower/Creep 动作入口保持既有 `towerControl`/`homeDefender` 边界。

## 剩余风险

- revision 的替代分配中 Defender 实时坐标未知（plan 不持久化实时位置）——距离评分的 defender 维度退化为 0 差（不影响候选唯一性与确定性排序；候选按到目标距离排序为主维度）；
- plan 持久化的候选集合增加 Memory 占用（每 hostile 的 boundary rampart 候选列表，有界、随 plan 每 tick 重写）；
- `not_participating` 显式语义当前无生产写入方（planner 为全部参与 defender 生成 entry）——字段保留为消费端显式协议锚点；
- hold 语义收紧后，configName 缺失（Memory.creeps 残缺）的 defender 在有 fresh plan 时不再独立作战（默认 hold）——异常状态的可观测性依赖 plan 覆盖率诊断。
