# Round 22 Remediation VI — All-Actor Rampart Reservation & Fallback Real Facts（本地验证 evidence）

- 日期：2026-09-04
- 分支：`refactor/empire-treasury-rearchitecture`
- 实际起始 HEAD：`de0656d73959ab7f18f76468d127774731b79219`（与预期一致）
- 最终代码/测试验证 HEAD：`ad0002e96887a40aae0cda6ad484332f46cfabbb`（完整验证在此 HEAD 执行；其后的 OpenSpec/evidence/budget 提交不含生产代码、测试代码或类型代码）
- 验证环境：本地 Windows（无独立 CI；Defense 测试全部使用 mock/spies——不连接真实游戏环境）

## 提交清单（本轮 Defense）

| commit | 职责 |
| --- | --- |
| `fix(defense): reserve ramparts for every participating defender`（`a09a177`） | planner 的 direct-actor 占用权威（occupied + reservedPosition + 候选共享数组）、homeDefense occupied 采集参与集判定、fallback revision 真实 role/坐标 + used 集扩展 + per-slot mode 联合、runtime.d.ts schema 指纹 |
| `test(defense): cover direct actor occupancy and fallback allocation`（`ad0002e`） | defenseAllActorReservation.test.ts（11 tests，D1–D7）+ memoryDeclarationBoundaries 指纹更新 |

## direct attack/ranged actor 的 Rampart reservation

planner 在 allocate 窗口前无条件构造候选集合（plan 持久化与 allocate 输入共享同一数组引用）：全部 mode=attack/ranged_attack 的 direct entry 逐一比对 defender 快照坐标——命中任一 target 的候选 → 该候选标 `occupied: true`（plan 持久化）+ entry 携带 `reservedPosition`。actor 不停止攻击、不被迫移动；未站合法候选（inside/其它 tile）不产生保留事实。

## room-level used-position 单一语义

occupied 标记（采集层 + direct-actor 权威）+ allocate 内部 `usedCandidateIds`（坐标键 `"x,y"`）+ fallback revision 的 `usedPositionKeys`（retained originalPosition ∪ direct-actor reservedPosition）构成同一坐标唯一语义——同一位置不可能出现在两个 slot 的 position/reservedPosition 中（D1 断言全房间位置唯一）。homeDefense 的采集不再无条件跳过 homeDefender：参与 plan 者（slotsByCreepName 有 slot）的位置保留由 planner 承载，非参与者与其它 my creep 一样占用标记。

## fallback 使用真实 role/position

plan 持久化 `defenderFactsBySlot`（planner 输入快照：真实 role + 当前坐标）；fallback revision 的 reallocationInput 用真实 role（primary→secondary→slot 稳定排序保持优先级）与真实坐标（`chebyshev(candidate, defender)` 维度真实生效）——不再 target anchor 近似、不再硬编码 secondary。revision 的 unaffected direct actor 保留原动作（mode attack/ranged_attack 原样输出 + reservedPosition 透传）。

## D1–D7 对应测试名（defenseAllActorReservation.test.ts）

| 反例 | 测试 |
| --- | --- |
| D1 | "D1：melee direct attacker 站 R1（与 hostile 距离 1）→ R1 被保留，approach Defender 获得 R2，无重复位置" |
| D2 | "D2：候选只有 R1（被 direct attacker 占据）→ 后续 Defender 明确 hold" |
| D3 | "D3：ranged direct attacker（射程 3 内、当前位于 R1）→ R1 同样保留" |
| （附加） | "direct actor 不站合法候选 Rampart（如 inside/其它 tile）→ 不产生保留事实" |
| D4 | "D4：fallback 不抢 unaffected direct actor 的 Rampart（D1 保留 attack + R1，replacement 只能获得 R2 或 hold）" + "D4b：replacement 候选只有被保留的 R1 → 明确 hold（不抢占）" |
| D5 | "D5：fallback role 优先级——primary 按 allocate 规则优先获得更近候选；输入顺序反转 per-slot 结果不变" |
| D6 | "D6：fallback 使用真实 Defender 距离（target anchor 近似会得到相反结果）" |
| D7 | "D7a：direct attacker 的 plan assignment（attack + reservedPosition）→ 消费继续 attack"、"D7b：候选 Rampart 不足的显式 hold → 不 moveTo、不追逐边界外 hostile"、"D7c：canonical slot 正常消费 fallback revision 的 attack entry" |

fresh plan missing assignment / explicit hold / not_participating / stale plan / canonical slot 的完整消费回归由 `defenseFallbackReallocation.test.ts` 十一节（5 tests）继续承载（本轮未修改、全部通过）。

## input-order stability

- planner：allocate 内 primary→secondary→slot 稳定排序（既有语义，defenseFocusFire 确定性测试继续锚定乱序输入同 plan）；
- fallback revision：`slots` 按字典序固定排序 + allocate 稳定排序——D5 以 defenderFronts 键插入顺序反转构造两个 plan，断言 `defenderEngagementBySlot` 完全相等；
- Tower-first / Defender-first 消费顺序任意性由 revision memo（plan 持久 + requests 计数）承载（defenseFallbackReallocation / defenseFocusFireStateful 的既有断言继续通过）。

## Rampart 不足时 hold

planner：候选全被占用/不足 → `{ targetId, mode: "hold" }`（保留 combat target，本 tick 伤害 0，不追逐边界外 hostile——D2）；fallback revision：used 集占满候选 → hold（D4b）；消费层 approach+hold → 零 attack/零 rangedAttack/零 moveTo（D7b）。

## fresh-plan missing assignment 回归

fresh plan 存在但 slot 无 entry → `return false` 默认 hold（零动作）；显式 `participation: "not_participating"` 是唯一走旧独立行为的显式语义；stale/无 plan 保留旧安全 fallback；canonical slot（configName 最后段）正常消费 assignment（defenseFallbackReallocation 十一节 A–E 全部通过）。

## 验证结果（全部本地执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| Defense 定向 | `npx jest --config jest.config.cjs src/runtime/defenseAllActorReservation.test.ts src/runtime/defenseFallbackReallocation.test.ts src/runtime/defenseFocusFire.test.ts src/runtime/defenseFocusFireStateful.test.ts src/runtime/homeDefense.test.ts src/roles/homeDefender.test.ts src/runtime/towerControl.test.ts test/memoryDeclarationBoundaries.test.ts` | 8 suites / 93 tests / 93 passed / 0 failed |
| memory boundary | `npx jest --config jest.config.cjs test/memoryDeclarationBoundaries.test.ts` | 1 suite / 6 tests / 6 passed（runtime schema 指纹 `741155d57d7b691526498675c2d0452342b3fcb9d790d2e2e8f03e155732ce30`） |
| 全仓 Jest | `npx jest --config jest.config.cjs` | 270 suites / 2151 tests / 2151 passed / 0 failed / 0 pending / 0 todo |
| typecheck / build | `npx tsc --noEmit -p tsconfig.json` / `npm run build` | 通过（无循环依赖警告） |
| bundle SHA-256 | `sha256sum dist/main.js` | `45108530802db57ec0255fc5358bb97055618964af18c5bc1a212a43bc54ec93` |

## 未部署声明

本轮未部署到 Screeps、未在线调参 Defense 常量、未让测试访问真实 Screeps API（全部 mock/spies）、未合并 main。未宣称任何线上验证。
