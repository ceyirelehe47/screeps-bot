# Round 22 Remediation IV — Front-aware Defender Allocation（本地验证证据）

- 日期：2026-09-03
- 分支：`refactor/empire-treasury-rearchitecture`
- 预期起始 HEAD：`a4bcbe8336e265ffcb53425de95caa6f8fa830f0`
- 实际起始 HEAD：`a4bcbe8336e265ffcb53425de95caa6f8fa830f0`（一致）
- 最终代码/测试验证 HEAD：`91a11f5cc59df0b710db832e096602ad9f5b378f`
- 最终分支 HEAD：见本文件所在 commit（其后仅允许纯文档/budget 差异）

## Commits（Defense 部分）

| SHA | 作用 |
| --- | --- |
| `5430127` | fix(defense): constrain defenders by front and reuse target-specific damage（front eligibility / zero-damage 再利用 / per-defender rampart / fallback revision / fresh plan authority） |
| `3fcbf37` | test(defense): cover multi-front ramparts and actor-specific fallback（新 suite defenseFrontAware 26 tests + 既有对齐） |
| `91a11f5` | test(memory): runtime schema fingerprint（defenseEngagement 增 defenderFronts/fallbackRevision/targetId 可空） |

## Defense front eligibility 矩阵（十三）

| Actor | 默认 eligibility | 实测 |
| --- | --- | --- |
| Tower | 房间内任意合法 hostile | FrontAware-2（Tower 支援北 front） |
| Defender（assigned front） | 本 front hostile 集合（预计算 O(1)） | FrontAware-2「各守本 front」 |
| Defender（未分配 front） | room-scope 保守默认 | FrontAware-2「未分配 front」 |
| Defender（跨 front 增援） | 仅既有协调系统显式标记 | defenderFrontEligibility 单元语义 |
| kill feasibility | 只计入 eligible Defender（borrow 不虚构 burst） | FrontAware-2「借南 Defender 不可击杀→非 killable + 南 hold」 |
| primary 在其它 front | Defender 不跟随 | FrontAware-2「primary 在北→南守南」 |

## Zero-primary-damage 反例（十四.3 固定反例）

```
Primary P：一座 Tower 可独立击杀。
Defender D：对 P 本 tick 伤害 = 0；对 S 本 tick 伤害足以击杀。
期望：Tower → P；Defender D → S。
```
实测（defenseFrontAware「固定反例·精确布局」）：`towerAssignments.t1 ===
"P"`、`defenderAssignments["0"] === "S"`（mode attack）。伴随矩阵：对
S 正但不足 → 参与 S 压制；对全部目标 0 → positioning（engage_position，
combat target 保留）；零伤害 Defender 不进入 kill budget
（`killExpected === true` 由 Tower 单独达成）；输入顺序反转语义相同。

## 多 front 分配实例（十三.4）

两 front（北/南各 1 hostile + 各 1 Defender）：北 Defender → north_1、
南 Defender → south_1（primary=north_1 时南不跟随）；hostile/front 输入
顺序反转结果不变（确定性——defenderFronts.eligibleTargetIds 按计划候选
顺序构造）。

## Unique Rampart 实例（十五）

- 两/三名 Defender 同 target（boundary 候选 r1/r2/r3）→ 全部位置唯一
  （per-defender 不同格）；
- 候选少于 Defender → 未分配者 `hold`（combat target 保留——不重复位置、
  不追逐边界外 hostile）；
- occupied 候选跳过；已站合法候选保留；primary/secondary 平手 primary
  获更优位置；候选顺序反转 per-slot 结果相同。

## Fallback revision 实例（十六）

- 北目标失效 → 北 Defender 转北替代（north_2）、南 Defender 保持
  south_1、Tower 按房间级 revision（towerTargetByTowerId）；
- 南先请求 → 南无 front-local 替代 → hold（北不被转到南）；
- 多 target 同时失效 → 一次 revision 生成（fromCache 语义 + requests
  计数）；Tower 先/Defender 先消费同一 revision（对象同一）；
- 无存活 hostile → Tower 与 Defender 全部 null（共同 idle）；多房间隔离。

## Fresh plan authority（十七）

- focusTargetId=null（no-hostile / no-attack-actor）的 fresh plan：全部
  参与 Defender 获得显式 hold/engage_position（不缺 assignment）；
  towerControl 对该 plan 服从（emergency heal 执行、攻击塔明确 idle——
  towerControl.test 既有矩阵 + 消费侧条件从 `focusTargetId !== null`
  收紧为 `plan !== null`）；
- Defender 的 defenderEngagements[slot] 存在即服从（含 hold）；
  defenderAssignments 不再作为回落（homeDefender.test fixture 对齐）；
  slot 不在 plan = planner 明确未参与（保留独立行为）；stale plan 按
  既有安全 fallback。

## Operation-count（十九节 Defense 部分）

- 多 Defender（6 名）单次 planner 调用（plannerStats.invocations +1）；
- 多 consumer（10 次）fallback 只生成一次 revision（requests=10、单次
  生成）；
- Rampart 分配为 O(Defenders×候选) 稳定 greedy（单元实测）；无
  PathFinder、无指数匹配；每房间每 tick 一次快照（既有 homeDefense
  结构保持）。

## 实际验证命令与结果（验证 HEAD `91a11f5`）

```
npx jest --config jest.config.cjs \
  src/runtime/defenseFocusFire.test.ts \
  src/runtime/defenseFocusFireStateful.test.ts \
  src/runtime/homeDefense.test.ts \
  src/runtime/towerControl.test.ts \
  src/runtime/towerControl.scanThrottle.test.ts \
  src/runtime/hostilePriorities.test.ts \
  src/roles/homeDefender.test.ts \
  src/runtime/defenseFrontAware.test.ts
                                                  → 8 suites / 97 tests / 97 passed
npx jest --config jest.config.cjs test/memoryDeclarationBoundaries.test.ts
                                                  → 1 suite / 6 tests / 6 passed
npx jest --config jest.config.cjs                 → 266 suites / 2067 tests / 2067 passed
```

- 新增 suite：`defenseFrontAware.test.ts`（26 tests）；既有 Defense 测试
  对齐（fallback revision API / plan fixture / positioning 语义）零删除
  零跳过。
- Suites：266；Tests：2067；passed：2067；failed：0；pending：0；
  todo：0；skipped：0。
- CI：本仓库无独立 CI 配置——以上全部为本地验证，不声称 CI passed。

## 边界声明

- 未部署；未合并 main；未调用真实 `terminal.send()`；未调用真实经济
  writer。
- Defense 生产路径存在既有 Tower/Creep 战斗动作入口（tower.attack/heal、
  creep.attack/rangedAttack、moveTo——本轮未新增任何散落的动作入口）；
  全部测试使用 mock Game 对象/纯快照数据，不调用真实 Game 写 API。
- Defense 常量（kill margin、紧急治疗阈值、maxDefenders、front 聚类
  范围）与多 front 策略（每 front 一 Defender 的 slot 轮转）尚未经线上
  canary——评分与站位策略仍需线上调参。
- Screeps hard CPU interruption 与 Memory flush 仍不构成 exactly-once
  保证。

## 剩余风险

- 多 front 评分权重与 Rampart 选择的战斗效率未经线上验证（需要 canary
  数据校准 front 聚类范围与 desired count 公式）；
- front ID（`front:${index}` 按威胁排序）在 hostile 分布变化时索引重排
  ——defenderAssignments 每 tick 重算保持一致，但跨 tick 的语义连续性
  依赖既有 writeDefenseFronts 清理逻辑；
- planner 的 suppression 压制只消费正伤害 actor：对全部目标零伤害的
  Defender 保持 positioning/hold——长期挂机场景由 homeDefense 的
  desiredCount 收缩处理。
