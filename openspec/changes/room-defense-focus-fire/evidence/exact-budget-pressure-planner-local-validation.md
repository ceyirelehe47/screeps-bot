# Defense Focus-Fire — Exact Budget & Pressure Planner（Remediation II 本地验证证据）

- 变更分支：`refactor/empire-treasury-rearchitecture`
- 实现提交：`a9f4eb2`（fix(defense): align focus-fire budget with executable damage）
- 验证环境：本地（jest 全部 mock），**未部署到 Screeps**
- planner 保持纯函数；最终 Game 动作仍只经 towerControl / homeDefender 既有入口

## 一、缺陷根因与修复对照（任务书五节 A–G）

### A. 紧急治疗仲裁必须先于攻击预算

**根因**：`planRoomEngagement` 先用全部有能量塔做目标评分，再计算
`emergencyHealByTowerId`——目标选择与击杀可行性使用了即将被治疗占用的
塔的火力。

**修复**：仲裁移到评分之前；治疗塔从攻击 actor 集合移除；killExpected 与
全部评分只按 attack-actor-only 预算。测试：两塔全攻 net>0、一塔被占用后
剩余 net≤0 → `killExpected=false` 且仍给出共享 pressure 目标。

### B/C. 跨阈值 Actor 不得 spill；击杀预算含敌方本 tick 治疗

**根因**：旧 `assignActor` 在 `focusAssignedDamage + damage >= killThreshold`
时把**负责跨越阈值的当前 actor** 派给 secondary（primary 永远达不到预算）；
`killThreshold = hits × 1.15` 不含敌方治疗。

**修复**：spill 条件改为「primary **已分配**累计有效伤害 ≥
`ceil((hits + incomingHeal) × FOCUS_FIRE_KILL_OVERKILL_MARGIN)`」——跨越
者恒留 primary；`focusAssignedDamage` 只累计实际分配给 primary 的顺序模拟
有效伤害。固定反例：600 hits + 100 heal + 两座 600 塔两座全攻 primary
（预算 ceil(700×1.15)=805 > 单塔 600），`focusAssignedDamage=1200`。

### D. Tower 与 Defender 共享真实 TOUGH/boost 有效伤害模型

**根因**：TOUGH 比例按塔总伤一次折算只作用于塔；防御者 melee/ranged 原始
伤害直接相加；Defender-only 场景 `toughDamageRatio` 默认 1。

**修复**：snapshot 携带 `toughProfile`（身体部件按序 `{hits, damageRatio}`），
`applyRawDamage` 做顺序伤害模拟（与 Screeps `_applyDamage` 同算法：伤害按
部件顺序消耗、boosted 部件按 ratio 折算吸收、跨 actor 状态延续——聚合结果
与单次大额调用一致）。目标选择、kill 累计、secondary 评分同一模型。
测试：Defender-only 120 raw 对 `[TOUGH(100,0.3)]` → 36 有效 < 120；
治疗 36 覆盖时无虚假 killExpected。

### E. Secondary 必须按剩余 actor 重新计算

**根因**：旧 spill 候选用「全部 actor 对目标的 fullPower」静态评分一次。

**修复**：每次 spill 用**尚未分配**的 actor 集合对候选逐个重做顺序模拟评分
（目标特定有效伤害/射程/TOUGH/敌方治疗全部重算；已分配 actor 不再计入任
何 secondary 预算；零伤害 actor 不改变候选击杀预算）。测试：全军预算净伤
A(1300)>B(1100)、剩余 actor 净伤 B(800)>A(700) 的构造下全部 spilled 塔选
B；零伤害 spilled 防御者确定性分给评分最高的压制候选。

### F. 不可击杀场景仍保持共享战略压制目标

**根因**：全部目标 net≤0 时返回 `focusTargetId=null +
fallbackReason=no-net-positive-target`，Tower/homeDefender 双双回退独立评
分再度拆火。

**修复**：候选排序键 `[net>0, score, id]`——无 net>0 候选仍取最高分为共
享 primary（`killExpected=false`，全部 actor 压制该目标，不 spill）；
fallback 仅限 `no-hostile` / `no-attack-actor`（能量 < TOWER_ACTION_
ENERGY_COST 的塔不参与攻击也不参与治疗仲裁）。towerControl 消费侧测试：
pressure plan 仍是唯一权威，塔攻击共享压制目标而非独立评分。

### G. Planner 预算与 homeDefender 本 tick 真实动作一致

**根因**：planner 计入 `rangedDamage` 但 homeDefender 只调用 `attack()`；
显式分配存在时旧 secondary 去重 / coverage rampart / 独立评分可把防御者
改到另一目标。

**修复**：单一语义源 `executableDefenderDamage` /
`defenderEngagementMode`（贴身 → attack（melee 优先）；纯远程（无 ATTACK
部件）≤3 → rangedAttack 并真实执行；需要移动 → 计 0 且移动朝共享目标）。
homeDefender 新增显式计划目标专属路径：attack / rangedAttack / move 三态
与 planner 完全同口径；目标失效本 tick 保守空转等重规划，不回退独立选敌。
`readFocusFirePlannerStatsForTest` 观测计数证明消费方（runTowerControl）
零重评分。

## 二、回归测试矩阵（任务书六节 1–12）

| # | 场景 | 位置 | 断言要点 |
|---|---|---|---|
| 1 | 跨阈值 actor | defenseFocusFire ×2 | 600+100 双塔全攻 primary；heal 350 预算 495 单塔达标后第二塔才 spill |
| 2 | emergency-heal 预算顺序 | defenseFocusFire | 治疗塔不出现在 towerAssignments；剩余火力 net≤0 不虚报可击杀；共享 pressure 目标 |
| 3 | Defender-only boosted TOUGH | defenseFocusFire ×2 | 120 raw → 36 有效；治疗覆盖无虚假 killExpected |
| 4 | ranged 行为对齐 | defenseFocusFire + homeDefender | 纯远程 ≤3 实际调用 `rangedAttack(计划目标)`；混合编队 range 2 移动计 0 |
| 5 | 剩余 actor secondary | defenseFocusFire | 全军选 A / 剩余选 B → 选 B |
| 6 | 当前 actor 无法攻击 secondary | defenseFocusFire | 零伤害不计入 secondary 击杀预算（确定性压制分配） |
| 7 | 全部 net≤0 | defenseFocusFire + towerControl | focusTargetId 非 null、killExpected=false、无 fallbackReason；塔按 plan 攻击共享目标 |
| 8 | 显式计划目标优先 | homeDefender ×3 | attack/rangedAttack/移动朝计划目标；不走 coverage rampart/独立评分 |
| 9 | 治疗塔不出现 towerAssignments | defenseFocusFire + towerControl | planner 不分配 + 执行层 heal 而非 attack |
| 10 | 输入乱序深比较 | defenseFocusFire（既有） | 任意来源顺序 → 同 plan |
| 11 | 多房间隔离/fresh/清理 | defenseFocusFire + homeDefense（既有） | 继续全绿 |
| 12 | opcount/调用次数 | towerControl | runTowerControl 期间 planner 调用计数零增加 |

既有 14 个 sidecar 用例中「治疗全覆盖 → fallback」按新语义更新为共享压制
断言；TOUGH 用例改为顺序模拟精确值（600 raw → 367 有效）；其余 12 个原样
通过。

## 三、最终验证命令与结果

与 Treasury evidence 同一工作树：

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npm run build` | 成功（未部署） |
| `npx jest src/runtime/defenseFocusFire.test.ts src/runtime/homeDefense.test.ts src/runtime/towerControl.test.ts src/runtime/towerControl.scanThrottle.test.ts src/runtime/hostilePriorities.test.ts` | 5 suites / 40 tests 全过 |
| `npx jest test/memoryDeclarationBoundaries.test.ts` | 6/6（killExpected 字段指纹 01177203…） |
| `npx jest`（全仓） | 262 suites / 1956 tests 全过 |
| `node scripts/verify-jest-budget.mjs` | `JEST_TEST_BUDGET=PASSED`（262/1956） |

## 四、诚实声明

- **未部署**、**未调用真实 Game 写 API**、**未调用真实 terminal.send**；
  全部测试使用 mock（MockPos / jest.fn towers / 手工 Memory plan）。
- `FOCUS_FIRE_KILL_OVERKILL_MARGIN` / `EMERGENCY_HEAL_*` /
  `TOWER_ACTION_ENERGY_COST` 等常量**未经线上调参**（本轮只保证确定性、
  预算口径与执行一致性）。
- planner 顺序伤害模拟按 plan 的确定性 actor 顺序近似同 tick 引擎结算
  （TOUGH 部件跨 actor 延续与聚合一致）；线上极端 tick 顺序差异不改变
  fail-safe 语义。
- 剩余遗留：防御者 boost 伤害按 body 明细计入但执行层 mode 判定用
  `getActiveBodyparts` 计数（两者只影响"是否>0"的等价判定，不影响数值）；
  pressure 目标的战略评分权重未经实战调参。

## 五、验收附记：纯远程贴身语义对齐

独立验收发现 `executableDefenderDamage` 首分支未排除纯远程（melee=0）
防御者——贴身（range 1）时 planner 计 0 而执行层按
`defenderEngagementMode` 实际执行 `rangedAttack`（欠估方向，安全但
语义分歧）。已修复为与 mode 判定完全同口径（`range <= 1 && melee > 0`
才计 melee；纯远程 ≤3 一律计 ranged，含贴身），并在语义测试中固化
range=1 纯远程断言（`executableDefenderDamage = 60`、mode =
`"ranged_attack"`）。测试计数不变（26），budget target 不受影响。
