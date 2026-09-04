# Global Rampart Footprints 本地验证证据（Round 22 Remediation IX 工作流 10）

- 日期：2026-09-03
- 分支：`refactor/empire-treasury-rearchitecture`
- 起始 HEAD：`826aebbd35240441f7c53efbce92462b5daa4f79`
- 最终代码/测试验证 HEAD：`e28df92e76985a6f12a505af5da9525796f24311`

## 1. global coordinate ownership 的定义

房间级 `coordinate → physical owner slot` 的 ownership snapshot：候选坐标全集来自**全部 target 的候选数组**（同一坐标可含不同 candidate ID——物理同一 Rampart）；`collectPhysicalCandidateFootprints`（physicalRampartOwnership）以 slot 字典序决胜同 tile 多 defender（确定性、输入顺序无关）。claim 的坐标经 `markCandidateOccupiedGlobally` 在全部 target 候选数组中一并标 occupied——Rampart 唯一性按坐标、不按 candidate ID。

## 2. planner 与 fallback 共享入口

- planner（defenseFocusFire）：import `candidateKeyOf`/`collectPhysicalCandidateFootprints`；stationary 保留、pending claim、hold 脚下回填、engage 二次标记统一消费 `ownershipFootprints` + `markCandidateOccupiedGlobally`。
- fallback（engagementFallbackRevision）：坐标键统一 `candidateKeyOf`；retained hold 第三路的 facts footprint 经 `collectPhysicalCandidateFootprints` 构建。
- D23 架构扫描断言两侧源码都引用 physicalRampartOwnership（不再只存在于测试）。

## 3. 跨 target 相同坐标 / candidate ID 不同坐标相同的处理

- 跨 target 共享坐标：T1 候选 `r1(24,25)` 与 T2 候选 `t2-r-shared(24,25)` 是同一物理 Rampart——D0（target=T1）claim 后 D1（target=T2）不得获得（D16 hold / D17 只能得 R2）。
- candidate ID 不同：D21 输入顺序反转用例把 candidate ID 重命名（`r1-renamed`/`t2-r-shared-renamed`）——per-slot mode/position/reservedPosition 与正向完全一致（坐标语义，ID 不参与唯一性）。

## 4. D16-D23 对应测试

| 反例 | 测试（defenseGlobalRampartFootprints.test.ts，9 tests） |
|---|---|
| D16 | planner 层：跨 target 共享 R1 → D0 claim 保留、D1 hold |
| D17 | fallback 层：双 replacement、共享 R1 + R2 → occupant claim R1、另一 replacement 得 R2 |
| D18 | fallback 层：共享 R1 唯一 revised 候选 → 后到者 hold |
| D19 | planner 层：participant + non-participant + 跨 target 共享混合——跨 actor 坐标全局唯一 |
| D20 | 消费层：same-target 的 VIII 语义不回归（occupant 只允许移动到自己的位置） |
| D21 | planner 层：输入顺序反转 per-slot 结果一致 |
| D22 | 消费层：loser hold 不 moveTo、不追逐边界外敌人 |
| D23 | 架构扫描：planner/fallback 共享入口 + 坐标唯一性（字典序决胜确定性） |

## 5. 输入顺序稳定性

D21：Defender 数组顺序、hostile（target）顺序、candidate 数组顺序与 candidate ID 全部反转——per-slot mode/target/position/reservedPosition 与正向运行一致（claim 按 slot 字典序、footprint 决胜字典序——确定性）。

## 6. loser hold 与 consumer 行为

D22：hold loser（候选被 claim 后变 hold）在 homeDefender 消费层零 moveTo、零攻击追逐（不追边界外敌人）；direct attacker 语义由既有 D15/VIII 测试保持（本轮 D20 复验 occupant 的 engage_position 消费只允许移动到自己的位置）。

## 7. 定向与全仓精确结果

| 项目 | 结果 |
|---|---|
| 定向 Defense（defenseGlobalRampartFootprints + defensePreallocationRampartOwnership + defenseStationaryRampartOwnership + defenseAllActorReservation + defenseFallbackReallocation + defenseFocusFire + defenseFocusFireStateful + homeDefense + towerControl + homeDefender + memoryDeclarationBoundaries，11 文件） | 11 suites / 118 passed |
| 全仓 Jest | 277 suites / 2316 passed / 0 failed / 0 pending / 0 todo |
| typecheck / build | 0 错误 / 成功（bundle SHA-256 `c08a03b8458ab2d2f35e5ecadd364844d38cf3ddc6516218ca78b2f446768f6c`） |

## 8. 声明

- 未在线调参 Defense 常量（全部行为由本地 mock/spies 验证）。
- 未部署到 Screeps、未调用真实写 API。
- 保守一 tick ownership 语义保持（VIII 既有收敛不回归——D9-D15 全部通过）。
