# Round 22 Remediation VIII — Pre-allocation Stationary Rampart Ownership 本地验证证据

## 概要

- 日期：2026-09-03
- 分支：`refactor/empire-treasury-rearchitecture`
- 起始 HEAD：`7f102d9901f80497b57403171508739ff520ab62`（与预期一致）
- 最终代码/测试验证 HEAD：`10ff781996f818b8c7ec76ae42dca72075d36431`
- 无独立 CI——全部结果为本地实际执行。

## 物理 occupied Rampart snapshot 的权威定义

- 新增 `src/runtime/physicalRampartOwnership.ts`——planner 与 fallback
  revision 共享的占用判定单一入口（架构语义：两处不得各自维护不同
  occupied 语义；共享入口测试守护 slot 字典序决胜 / 输入顺序无关 /
  非候选坐标不产生 footprint）。
- **采用保守的一 tick ownership**：pending boundary Defender 站在
  **自己 target** 的未占用候选上时在 allocate 之前直接 claim
  （engage_position = 当前 tile + reservedPosition + 候选标 occupied）；
  occupant 保留当前位置、其他 Defender 本 tick 不可获得该位置。
- 站在别的 target 候选 / 非候选上的成员照常进入 allocator（同 target
  内 on-tile 距离 0 天然优先）；**变 hold 的 loser**（allocate 后候选
  不足）脚下命中合法候选时保留当前位置事实（occupied +
  reservedPosition——与 fallback 的 D5 语义对称）。
- 未采用同 tick transfer：位置转让只在 occupant 实际离开后的下一 tick
  发生（无环冲突、不依赖"预计它会走"）。

## participating / non-participating actor 的处理

- **参与计划且已有 entry**（attack / ranged_attack / hold /
  engage_position-on-tile）：Remediation VII 的预标记 / 二次标记保留
  （reservedPosition + 候选 occupied）；
- **参与计划但 entry 未定的 pending boundary Defender**：本轮新增的
  allocate 前 claim（F1 缺口的核心修复）；
- **未参与计划的 Defender**：采集层（homeDefense）的 occupiedRampartKeys
  以候选 `occupied: true` 进入 plan（既有语义——planner 不重复分配）；
- **fallback revision 中即将重新分配的 Defender**：replacement claim
  （站在自己 revised target 的未占用候选 → 直接 claim + used 集合）。

## fallback revision 如何复用相同 occupancy

- replacement claim 使用与 planner 相同的判定（自己 target 的未占用
  候选 → occupant 优先）；claim 位置进入 usedPositionKeys 对其他
  replacement 排除；claim 按 slot 字典序处理（确定性）。

## D9–D15 对应测试（src/runtime/defensePreallocationRampartOwnership.test.ts）

| 反例 | 状态迁移（修复后） |
| --- | --- |
| D9 | D0（站 R1，pending）claim R1（engage_position + reservedPosition + r1 occupied）；D1 无候选 → hold——两人不再同时拥有 R1 |
| D10 | D0 claim R1；D1 只能获得 R2 |
| D11 | fallback：D0 claim R1（revised target 的候选）；D1 hold——不再出现"R1 分给 D1 后 D0 hold R1" |
| D12 | fallback：occupant 保留 R1；replacement 得 R2 |
| D13 | participant claim（r1）+ non-participant 采集层占用（r0）→ 候选 occupied = {r0, r1}，d1 只得 r2 |
| D14 | Defender / candidate 顺序反转 → per-slot 的 mode / targetId / position / reservedPosition 逐项一致 |
| D15 | 消费层：claim 后 hold 的 loser 不 moveTo、不追逐；direct attacker 继续攻击（不因占用保留停止） |

## 输入顺序稳定性

- planner claim 按 slot 字典序处理；allocator 既有 primary→secondary→slot
  稳定排序不变；fallback claim 继承 revisedSlots 的 slot 序。D14 断言
  顺序反转逐 slot 全等。

## 验证命令与真实数字

| 命令 | 结果 |
| --- | --- |
| `npx jest --config jest.config.cjs src/runtime/defensePreallocationRampartOwnership.test.ts src/runtime/defenseStationaryRampartOwnership.test.ts src/runtime/defenseAllActorReservation.test.ts src/runtime/defenseFallbackReallocation.test.ts src/runtime/defenseFocusFire.test.ts src/runtime/defenseFocusFireStateful.test.ts src/runtime/homeDefense.test.ts src/roles/homeDefender.test.ts src/runtime/towerControl.test.ts test/memoryDeclarationBoundaries.test.ts` | 10 suites / **109 tests** 全过（含既有 D1-D8 全部保留通过） |
| 全仓 `npx jest --config jest.config.cjs` | 274 suites / 2255 tests 全过 |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| `npm run build` | 成功 |
| `sha256sum dist/main.js` | `c730c3e2ea6fb78600ac58f0ece257bd210e9851a7386dbe65cd4d413cbbba00` |

## 声明

- 未部署到 Screeps；未在线调参 Defense 常量；未调用真实 Game 写动作
  （全部 mock/spies）。
- 无独立 CI——本报告为本地实际验证结果。
