# Round 22 Remediation VII — Stationary Defender Rampart Ownership（本地验证 evidence）

- 日期：2026-09-04
- 分支：`refactor/empire-treasury-rearchitecture`
- 起始 HEAD：`e8969aa0400bec5e853f5692bf87b42b21a52993`（与预期一致）
- 最终代码/测试验证 HEAD：`c5864f5`（test(defense) 提交——完整验证在此 HEAD 执行）
- 验证环境：本地 Windows（无独立 CI——全部为本地执行结果）

## 提交清单（本轮 Defense）

| commit | 职责 |
| --- | --- |
| `fix(defense): reserve ramparts for stationary defenders`（`16e8f00`） | planner 保留循环扩展（hold 参与 stationary 占用）、allocate 后 engage_position-on-tile 二次标记、fallback revision used 集第三路 + retained hold 输出保持 hold + replacement hold 保留当前位置、homeDefense/runtime.d.ts 注释语义同步 |
| `test(defense): cover stationary ownership and fallback conflicts`（`c5864f5`） | defenseStationaryRampartOwnership.test.ts（8 tests，D1–D8） |

## stationary 判定规则

参与计划 + 当前站在合法 boundary Rampart 候选上 + 本 tick assignment 不会让其离开该 tile → 当前 Rampart 属于该 Defender（房间级 used-position 权威）。覆盖集合：

- `attack` / `ranged_attack`（direct actor——不因直接攻击从占用集合消失，不停止攻击）；
- `hold`（显式不动——无 front-local 候选/候选不足的 assignment）；
- `engage_position` 且分配位置 = 当前 tile（已站在目标 Rampart——allocate 后二次标记）；
- fallback revision 中 retained stationary assignment（含 replacement 无候选但当前在合法 Rampart 的 hold——reservedPosition 保留当前位置事实）。

正在移动腾位（分配位置 ≠ 当前 tile）的 engage_position 不保留。每房间每 tick plan/revision 至多一次；used-position 以坐标唯一；stationary 判定 O(Defenders × candidates) 有界；不调用 PathFinder。

## hold / engage_position 当前位置保留与 fallback used-position

- planner 保留循环：stationary actor 当前 tile 命中任一 target 的合法 boundary 候选 → 候选标 occupied（plan 持久化候选集与 allocate 输入共享同一数组引用——一处标记两视图同步）+ entry 携带 reservedPosition。
- allocate 二次标记：pendingBoundary 分配结果中 `allocated == defender 当前 tile` → 同样标 occupied + reservedPosition。
- fallback revision used 集合三路：retained 原独立位置 / retained reservedPosition / **retained hold 无 reservedPosition（旧 plan）——真实坐标来自 defenderFactsBySlot，命中 plan 任一候选集时进入 used**。
- retained hold 输出保持 `mode: "hold"` + reservedPosition（不再改写为无位置 engage_position——那会让消费方回落 target-level 单一位置重新制造共享位置冲突）；replacement 无合法候选的 hold 若当前在合法 Rampart 同样携带 reservedPosition（明确保留当前位置，hold actor 不被迫移动）。

## D1–D8 对应测试名（defenseStationaryRampartOwnership.test.ts）

| 反例 | 测试 |
| --- | --- |
| D1 | "D1：hold Defender 站 R1 → retained hold 携带 reservedPosition 且 used 集第三路生效——replacement 只能获得 R2" |
| D2 | "D2：候选只剩被 hold Defender 占据的 R1 → replacement 明确 hold（不 moveTo R1、不追逐）" |
| D3 | "D3：stationary engage_position（分配位置 = 当前 tile）→ R1 被保留（occupied + reservedPosition）" |
| D4 | "D4：unaffected hold actor 的原 target 仍存活 → 保持 hold + R1；fallback Defender 不得抢占 R1" |
| D5 | "D5：replacement 无合法候选但当前已在合法 Rampart → hold 携带当前位置保留事实" |
| D6 | "D6：direct attack / ranged_attack 的保留回归——不停止攻击、hold 消费不被迫移动"（planner attack + reservedPosition；消费层 hold 不 moveTo/不追逐） |
| D7 | "D7：非参与 Defender 的 Rampart（采集层 occupied 标记）不被 planner 重复分配" |
| D8 | "D8：输入顺序反转（Defender / candidate 数组）不改变 per-slot 语义"（mode/targetId/position/reservedPosition 逐项相等） |

## fresh-plan authority 回归与输入顺序稳定性

- fresh plan 缺 assignment 默认 hold、显式 hold、not_participating 旧独立行为、stale/no plan 旧安全 fallback 的完整回归继续由 `defenseFallbackReallocation.test.ts` 十一节承载（本轮未改动消费语义，全量回归通过）。
- D8 验证 Defender 数组与 candidate 数组反转后 per-slot mode/targetId/position/reservedPosition 完全一致（allocate 内部按 primary→secondary→slot 稳定排序；候选按 [到 target 距离, 到 defender 距离, id 字典序] 逐级决胜——与输入顺序无关）。

## 验证命令与结果（本地实际执行）

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | 通过 |
| `npx jest --config jest.config.cjs src/runtime/defenseStationaryRampartOwnership.test.ts` | 1 suite，8/8 passed |
| `npx jest --config jest.config.cjs src/runtime/defenseAllActorReservation.test.ts src/runtime/defenseFallbackReallocation.test.ts src/runtime/defenseFocusFire.test.ts src/runtime/defenseFocusFireStateful.test.ts src/runtime/homeDefense.test.ts src/roles/homeDefender.test.ts src/runtime/towerControl.test.ts src/runtime/defenseStationaryRampartOwnership.test.ts test/memoryDeclarationBoundaries.test.ts` | 9 suites，101/101 passed |
| `npx jest --config jest.config.cjs`（全仓） | 272 suites，2203/2203 passed |
| `sha256sum dist/main.js` | `3f1261b1a2a2373529a22ea000b4f2e7f7e5059192ebd6e5d1811211a489366d` |

## 未部署声明

本轮未部署到 Screeps、未在线调参 Defense 常量；planner 与 fallback revision 保持纯函数（不调用 Game 写 API）；所有 Game 写动作测试使用 mock/spies。GitHub 无独立 CI——以上全部为本地实际执行结果。
