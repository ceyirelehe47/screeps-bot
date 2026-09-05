# Core Rewrite I — 本地验证记录

日期：2026-09-05
仓库：ceyirelehe47/screeps-bot；分支：refactor/empire-treasury-rearchitecture
审查基线（预期起始 HEAD）：`cf2ee7b83a524bb8b0199bd889365336b254721b`
最终代码/测试验证 HEAD：`1df0a2801743a2444eb32ec577e2483c3d67dc68`
无 CI（任务书审查时远端 Actions runs = 0，本轮未新增 CI 配置）；以下全部为本地实测（Windows / Node 22 / ts-jest）。

## 1. 提交列表与职责

| commit | 职责 |
| --- | --- |
| `a3f06aa` | refactor(treasury)!: 核心重写——kernel/ 新内核（单一写入口状态机）、facade 重写为薄装配层、actionContracts 精简（执行入口退役 + adapter 执行语义声明）、旧协议栈 165 文件与 81 旧测试套件删除、runtime.d.ts treasuryCore v1 替换 |
| `0c03933` | test(treasury): 恢复基础查询侧 10 套件并适配新 API；policy withhold 接入接纳路径（fail closed）；settle 防伪造（reconciler 结论由 facade 内部调用得出）；worstCase 改带符号腿（接收容量检查修复流入腿遗漏） |
| `1df0a28` | test(treasury): 内核生命周期 28 tests + A01-A24 验收矩阵 41 tests + 压力/参考模型 6 tests + 架构守护 7 tests；结构矛盾校验（ring-active 重叠 / outcome-evidence 相反）；kernel journal 深冻结 |
| （本轮末尾） | docs(openspec)：proposal/design/tasks/authority-retirement-map/test-migration-map/本 evidence；chore(test)：新基线 budget 216/1099 |

## 2. 验证命令与结果（全部记录实际退出码）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | 零输出 | 0 |
| `npm run build` | dist/main.js 创建 | 0 |
| `npx jest src/runtime/treasury/ --runInBand` | 14 suites / 264 tests / 264 passed | 0 |
| Defense 定向回归（`--runTestsByPath` 11 文件：defenseFocusFire(26)/Stateful(24)/FallbackReallocation(13)/AllActorReservation(11)/GlobalRampartFootprints(9)/PreallocationRampartOwnership(8)/StationaryRampartOwnership(8)/homeDefense(2)/towerControl(5)/homeDefender(6)/memoryDeclarationBoundaries(6)） | 11 suites / 118 tests / 118 passed | 0 |
| 全仓 `npx jest --runInBand --json` | 216 suites / 1099 tests / 1099 passed / 0 failed / 0 pending / 0 todo | 0 |
| `node scripts/verify-jest-budget.mjs` | `JEST_TEST_BUDGET=PASSED`（216/1099，锚点 `1df0a28`） | 0 |
| `sha256sum dist/main.js` | `491e513c01e341449e7849ca32c863700ea184af388881ae59da6561dad8ba68` | 0 |
| `git diff --check` / `git status --short` | 干净（提交前） | 0 |

注意：验证 HEAD `1df0a28` 之后的提交只含 docs/evidence/budget 元数据（锚点常量与清单），不再改生产/测试代码——符合任务书 §12 边界。budget 脚本的功能性修改（锚点/目标常量）先经全量 Jest JSON 验证后写入。

## 3. 行为验收（A01-A24 全矩阵，treasuryKernelAcceptance.test.ts，41 tests）

全部通过。要点：
- **A01/A02**：字符串 ID（含旧 ti1_/ti2_/tr1_ 格式与 future canonical）零执行许可；frontier 洞不变成可执行记录、不建逐洞 proof、溢出不回绕。
- **A04（R1）**：dispatching 残留恢复保守化为 unknown（真调用计数不增、原身份事实不被覆盖）。
- **A05（R2）**：absent/healthy/unhealthy/incompatible 四态互斥；损坏不折叠为缺失；写入阻断且数据原样保留。
- **A06（R3）**：active(pending) 与 ring(同 attemptId committed) 结构矛盾 → unhealthy 阻断（校验与证据排列顺序无关）。
- **A07（R4）**：not_executed 与 executed 相反证据 → 结构矛盾；beginTick 清理不消除冲突。
- **A09/A10**：同 permit 重复/重入/多 facade 实例真实进入恰一次（宿主侧独立计数，非状态反推）；non-ok/throw 计数真实为 1。
- **A22**：Memory JSON 往返 + 服务重建 + tick 推进后活跃状态等价、旧 handle 不可复用。

## 4. 压力与参考模型（treasuryKernelStress.test.ts）

| 场景 | 结果 |
| --- | --- |
| 10,000 项完成工作生命周期 | 副作用恰 10,000 次（真计数）；峰值/终态序列化 < 32KB；活跃 ≤ 2；ring ≤ 128 |
| 1,000 次合法 retry 单链（末代 commit） | 副作用恰 1,000 次；每代新 attemptId；frontier 单调；ring 有界 |
| 固定 1 笔长期 unknown + 5,000 完成 | unknown 保持有界占用（1 条 active）；其余正常退出；副作用 5,001 |
| 满 active(64) + 满 ring(128) + 最坏记录（16 腿/192 错误/512 payload） | 新接纳拒绝；已接纳可收尾；总序列化 < 260KB 上界断言 |
| 小参考模型（2 槽/2 资源，独立实现不复用生产 reducer） | 30 轮 × 12 步随机事件序列：接纳放行/占用/退出判定与生产 kernel 完全一致 |

## 5. 架构守护（treasuryKernelArchitecture.test.ts，7 项）

旧协议 66 个文件名不存在；生产 treasury 代码零 import 旧路径；`applyTreasuryCoreStateCommand` runtime importer 唯一（kernel.ts）；生产模块零 import testHarness；`treasuryCore` 键只被 treasury 模块与类型声明引用；actionContracts 无 Game 市场写调用且 runtimeServices 只 seal 不注册；命令集封闭（union 无 default）。

## 6. Budget 变化

- 旧基线：`0476884` 锚点，283 suites / 2,462 tests。
- 新基线：`1df0a28` 锚点，216 suites / 1,099 tests（逐文件 budget 来自验证 HEAD 的全量 Jest JSON）。
- 变化构成：Treasury src 内 81→14 suites（182 保留适配 + 82 新增）；treasuryCommitmentInvalidationBoundaries 12→2。映射见 test-migration-map.md。
- protected-full 15 文件集合不变（新基线下 sha256 对比通过——含 fingerprints 更新后的 memoryDeclarationBoundaries.test.ts）。

## 7. 实际副作用计量方式

`makeTreasuryTestTransferAdapter` 的模块级 executions 计数器（进入 execute 第一步 bump）+ 测试宿主闭包轨迹（重入/多实例场景）。计量器自证先行（treasuryKernel.test.ts 首组 3 tests：正常/non-ok/throw 各计一、直接两次调用计二、前置拒绝为零），再用于全部内核断言。

## 8. 故障模型边界（design §4）

内核模拟已验证：已发布持久状态保留 + heap 全丢恢复；写入拒绝/读回不一致（clone-write-readback 回滚）；callback 进入但无结果（throw → unknown）；损坏/版本不兼容/结构矛盾 fail closed；JSON 序列化往返 reset 等价。
**未证明（部署阻断）**：真实 Screeps driver 的"效果保留而最新 Memory 回退"非原子窗口——该模型下跨 tick 重发不能被排除，因此真实经济 writer 保持禁用（生产 adapter 注册表为空），不以"测试 publish 成功"替代线上持久化保证。

## 9. 声明

- 未部署（未运行 deploy/upload 脚本；bundle hash 仅为构建产物记录）；未合并 main；未调用真实市场/terminal writer；未接触真实玩家 Memory（全部测试数据显式初始化）。
- Defense 冻结清单生产文件零改动（`git diff` 为空 + protected sha256 校验通过）。
- 旧 `Memory.runtime.treasury.*` 数据不解析、不擦除——发现即报告 incompatible 并阻断写入。
