# Tower 与主防 Creep 协同集火（Defense Focus-Fire Coordination Sidecar）本地验证证据

- 变更分支：`refactor/empire-treasury-rearchitecture`
- 代码提交：`194631f`（feat(defense)：planner + 接线 + 声明）、`8ac8d88`
  （test(defense)：确定性测试矩阵）
- 验证 HEAD：`8ac8d88`（budget 锚定提交；最终全套验证于 budget/evidence
  提交前的同一工作树状态运行，见第 6 节）
- 验证日期：2026-09-02（本地环境，未部署、测试只用 mock）

## 1. 调研结论（实现前完成）

- 敌我识别：`defenseMode.getPlayerHostiles`（player-owned 过滤）。
- 威胁评分：`defenseFronts.getHostileThreat`（body 组成加权）与
  `hostilePriorities.getInside/BoundaryDefensePriority` 并存。
- Tower 控制：`towerControl.runTowerControl` → `runTowerCombat`（独立评分
  `chooseFocusTarget` / spread 探测 / 有限协调窗口 `chooseCoordinatedBurstTarget`）。
- 主防 Creep：`roles/homeDefender`（`chooseInsideBurstTarget` /
  `chooseBoundaryBurstEngagement` 独立选目标 + safeZone/rampart 走位）。
- 协同通道：`defenseCoordination`（fronts / towerFocusFront /
  defenderAssignments / defenderRoles）——已持久化但无联合伤害预算。

## 2. 确定性协同失败案例（复现于 defenseFocusFire.test.ts 首用例）

场景：H_healer（伴随治疗 200/tick、body 威胁高）与 H_wounded（残血、无
治疗）同场，1 塔 + 1 贴身主防 Creep。旧语义下 Tower 的 net 评分与主防
Creep 的 body 优先级评分是两套独立函数，同一 tick 塔集火 X 而防御者攻击
Y 时敌方治疗只需分别抵消两路伤害（火力分裂）。本 sidecar 把防御者输出
计入联合预算后，plan 断言 Tower 与防御者锁定同一主目标
（`focusTargetId` / `towerAssignments` / `defenderAssignments` 三方一致）。

## 3. 设计与实现（独立模块，不改 Treasury 任何语义）

新模块 `src/runtime/defenseFocusFire.ts`（纯函数 planner + 快照采集 +
Memory.runtime.defenseEngagement 持久化，plannedAtTick fresh 校验）：

- **每房间每 tick 唯一 plan**：由 `homeDefense.runHomeDefense` 每房间一次
  快照 + 一次评分生成；`towerControl` 与 `homeDefender` 消费同一 plan。
- **联合伤害预算**：每塔距离衰减伤害 × TOUGH/boost 有效伤害比
  （复用 `towerControl.calcEffectiveDamage` 同源语义）+ 防御者近战
  （range ≤ 1）/远程（range ≤ 3）输出 - 敌方 range-aware 治疗（近程 1 /
  远程 ≤ 3，含 boost 乘区）。评分 `net × 1000 - hits × 0.2 + threat -
  残血加成`，与旧 `chooseFocusTarget` 语义兼容。
- **保守击杀 margin**：主目标累计分配伤害 ≥ `hits × 1.15` 后，追加
  actor 分火次级目标（次级 = 剩余净伤害候选中评分最高；无候选继续主
  目标——不浪费输出口）。
- **过量伤害控制**：由 margin 机制天然承载（首个 actor 恒定主目标，
  预算超阈值后逐 actor 溢出）。
- **Tower 紧急治疗仲裁**：重伤（hp 缺口 ≥ 35% × hitsMax）按缺口降序
  （id 字典序决胜）占用塔；紧急治疗塔数上限 = ceil(攻击塔 × 0.5)；轻伤
  不占塔；治疗塔不参与攻击分配。
- **fallback**：净伤害无可击穿目标 → `focusTargetId=null` +
  `fallbackReason`，消费方（towerControl）回退既有独立逻辑；plan 每房间
  每 tick 重写，回退仅发生在 plan 不可用的同一 tick（无循环重规划）；
  homeDefender 对失效分配本 tick 空转等待重规划（不回退独立评分再度
  分裂火力）。
- **CPU/opcount 约束**：每房间每 tick 一次快照（O(T×H + H² + D)）一次
  评分（O((T+D)×H)）；消费侧 O(T + D) 查表；全部候选按 id 字典序稳定
  排序，评分平手 id 决胜——确定性（打乱输入顺序产生相同 plan，测试断言
  `toEqual` 深比较）。
- **多房间隔离**：plan 按 roomName 分桶存储与清理（测试覆盖）。

## 4. 接线（保留既有最终执行边界）

- `homeDefense`：快照采集 + `planRoomEngagement` + 写 store（无新增
  Game API 调用点）。
- `towerControl.runTowerCombat`：有效 plan → `runTowerCombatWithPlan`
  （按 `emergencyHealByTowerId` 治疗重伤、`towerAssignments` 攻击；执行
  仍用既有 `tower.heal`/`tower.attack` 入口）；plan 缺失/过期/fallback →
  原逻辑。
- `roles/homeDefender`：`defenderAssignments[slot]` 优先（槽位与
  defenseCoordination 的 spawn config args 一致）；走位/攻击执行逻辑
  不变。
- 声明：`src/types/memory/runtime.d.ts` 新增 `defenseEngagement` 字段；
  `test/memoryDeclarationBoundaries.test.ts`（protected-full）冻结清单与
  schema 指纹同步更新（`2ebc5f89…`）。

## 5. 约束遵守

- 独立模块/独立测试/独立 commit（`194631f` feat + `8ac8d88` test）。
- 不新增散落直接 Game API 调用点（planner 纯数据；执行沿用
  towerControl/homeDefender 既有入口）。
- 未部署；测试全部使用 mock（无真实 Game API 调用；测试中的
  MockPos/StoreDefinition 断言对象不构成 writer 调用）。
- 未接入 terminal/market/lab/factory/物流/其它经济 writer。
- Treasury 语义零改动（store schema / proof profile / marker cleanup
  状态机 / Receipt / Resolution / writer kernel / 预算保护规则均未触碰；
  全仓测试含 Treasury 1182 项全绿佐证）。

## 6. 验证（HEAD = 8ac8d88，budget PASSED 运行的工作树状态）

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| `npm run build` | 成功（bundle sha256 `3885de739727d44b…`） |
| `npx jest --config jest.config.cjs src/runtime/defenseFocusFire.test.ts` | 1 suite / 14 tests 全过 |
| `npx jest --config jest.config.cjs src/runtime/homeDefense.test.ts src/runtime/towerControl.test.ts src/runtime/towerControl.scanThrottle.test.ts src/runtime/hostilePriorities.test.ts` | 4 suites / 12 tests 全过（既有防御模块回归） |
| `npx jest --config jest.config.cjs test/memoryDeclarationBoundaries.test.ts` | 6 tests 全过（声明边界） |
| `node scripts/verify-jest-budget.mjs` | `JEST_TEST_BUDGET=PASSED`（261 suites / 1902 tests，含完整全仓 jest 运行） |

最终全套验证于 budget/evidence 提交前在相同代码状态运行（见最终报告）；
budget 清单锚定 `8ac8d88`。

## 7. 遗留与如实声明

- planner 的协调范围是"目标与 actor 分配"级（房间级）；防御者走位（safe
  zone/rampart 选择）沿用既有逻辑——本 sidecar 不改变移动决策。
- 敌方治疗建模为确定性单 tick 快照（不考虑跨 tick 治疗链冷却）；保守
  margin（1.15）与紧急治疗阈值（35%）为常量，未做线上调参（未部署）。
- towerControl 的旧独立评分逻辑保留为 fallback 路径（plan 不可用时）。
