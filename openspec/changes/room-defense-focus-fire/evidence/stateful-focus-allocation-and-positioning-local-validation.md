# Stateful Focus Allocation & Positioning 本地验证

- 日期：2026-09-03
- 分支：`refactor/empire-treasury-rearchitecture`
- 预期起始 HEAD：`b1f2e2c9c5786372e66f336bab4b18c0beddf83a`
- 实际起始 HEAD：`b1f2e2c9c5786372e66f336bab4b18c0beddf83a`
- 最终代码/测试验证 HEAD：`e31e5cac895f929d6e2df0a3536e053c4946ba4a`

## 本轮 commits

| SHA | 作用 |
|---|---|
| `33719ea` | fix(defense): prioritize executable kills and allocate spill fire statefully——planner 三分类/预算化分配/stateful secondary/治疗选择 + plan 扩展 + 类型声明 |
| `0596574` | fix(defense): preserve rampart positioning and share live fallback targets——采集/消费侧（homeDefense 接敌位置、homeDefender 分离消费、towerControl 共享 fallback） |
| `e31e5ca` | test(defense): cover kill feasibility secondary focus and shared fallback（defenseFocusFireStateful 24 tests + towerControl/homeDefender 消费侧各 1） |

## Kill feasibility 分类

| 分类 | 判定 | 行为 |
|---|---|---|
| killable_this_tick | 全部可参与攻击 actor 的顺序模拟有效伤害 ≥ ceil((hits+heal)×1.15) | 成为 primary 候选；killExpected=true ⇔ 实际分配伤害达到预算 |
| positive_pressure | 联合有效伤害 − incomingHeal > 0（未达预算） | 压制桶（净伤害评分排序） |
| suppression_only | 净伤 ≤ 0 | 共同压制桶（killExpected=false） |

## 原始缺陷的确定性反例结果（defenseFocusFireStateful + 消费侧测试）

| # | 反例 | 结果 |
|---|---|---|
| 1 | 5000 血高净伤不可击杀 vs 100 血可击杀 | primary=可击杀目标（killable 桶优先）；killExpected=true ⇔ focusAssignedDamage ≥ killBudget（115）；达标后溢出 actor 转压制高威胁大目标 |
| 2 | 正净伤未达预算 | focusTargetClass=positive_pressure、killExpected=false（净伤为正不再等价于可击杀） |
| 3 | 全部不可击杀 | 共享 suppression、focusTarget 非 null |
| 4 | HEAL 核心 vs 普通目标（均可击杀） | HEAL 核心（healPower）优先成为 primary |
| 5 | 拆火反例（A 对 X 强、B 对 Y 强、联合只可压穿一个） | 剩余 actor 共同同一 secondary（评分平手稳定 ID）；不逐 actor 各自选敌 |
| 6 | secondary 达预算才切 tertiary | t1 杀 h1 → t2/t3 达 h2 预算（1035）→ 无 actor 溢出到 h3 |
| 7 | 移动中 Defender | 边际 0 不计入预算；engage_position 保留共享 combat target |
| 8 | boundary 目标 approach | moveToTarget 前往合法 rampart（30,30，range 0），不追 hostile（45,45） |
| 9 | fallback 多消费者 | 10 次请求 → 单次解析 + 9 次缓存（requests=10）；Tower/Defender 同一结果 |
| 10 | 治疗反例（近塔 400 vs ID 小的远塔 ~175，cap=1） | 近塔治疗、远塔进入攻击预算 |

## Primary/secondary allocation 示例（确定性）

输入：h1(100 血) / h2(900 血) / h3(4000 血)；t1/t2/t3（各 600）。
1. h1 killable（budget 115）→ 边际平手（600）按稳定 key：t1 分配即达标（cumulative 600 ≥ 115，停止——最少 actor/最小过量）。
2. 剩余 {t2,t3} 重评：h2 killable（1200 ≥ 1035）、h3 不可 → killable 桶选 h2；两塔均分（600 单塔不达 1035）。
3. h2 达标后无剩余 actor——h3 由下一 tick 重规划。
输入乱序（hostiles/towers/defenders 反转）→ plan 完全一致（确定性测试）。

## Shared fallback 行为

- plan 持久化 `fallbackTargetIds`（分类桶排序）；`resolveRoomEngagementFallbackTarget(roomName, failedId, aliveIds)` 按
  顺序探活，结果写回 plan 的 `fallbackResolution`（每房间每 tick 至多一次）。
- Tower（towerControl）与 Defender（homeDefender）消费同一缓存；无合法 fallback 共同空转（不回退独立评分）；多房间隔离；stale plan 不参与。
- 保留原计划的已分配治疗塔与 actor 可用边界（fallback 只替换攻击目标；engagement 位置随 target 的 `engagementByTargetId` 切换）。

## Operation-count

- planner 每房间每 tick 一次（`plannerStats.invocations` 消费零增长——towerControl 测试断言）。
- fallback：多消费者单次解析（requests 计数缓存命中）。
- 候选评分 O(hostiles×actors)、TOUGH 模拟 per hostile 有界快照、无指数子集搜索。
- journal/stage read-back 单键 O(1)（Treasury 侧：100 无关 entry 下 50 次 read-back 零 shapeFailures）。

## 验证命令与结果（最终代码 HEAD `e31e5ca`）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 通过 |
| Defense 定向（defenseFocusFire/homeDefense/towerControl/scanThrottle/hostilePriorities/homeDefender/defenseFocusFireStateful） | 7 suites / 71 tests 全过 |
| 全仓 | 264 suites / 2014 tests 全过 |
| `test/memoryDeclarationBoundaries.test.ts` | 6/6（runtime 声明 fingerprint 同步） |

## GitHub CI 实际状态

仓库无 CI workflow 配置与运行记录——只报告本地验证。

## 边界声明

- 未部署；Defense 评分常量（margin 1.15 / 治疗阈值 0.35 / cap 0.5）未经线上调参。
- planner 保持纯函数；全部执行动作仍经既有 Tower/homeDefender 边界（无新增散落的 attack/heal 入口）。
- 多房间与输入乱序确定性有测试；每房间每 tick 一次完整规划由 homeDefense 采集保证。
