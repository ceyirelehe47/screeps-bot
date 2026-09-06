# Core Rewrite IV · Remediation II — Agent 本地验证报告

- 日期：2026-09-06。任务书：`treasury-core-rewrite-IV-remediation-II-implementation.md`（验收索引 F01–F20）。
- 结论：R1–R3 与 V1–V3 全部修复并以矩阵/基线/负向变体验证；最终验证 HEAD 全链全 0 失败。

## 1. SHA 与职责

| 项 | 值 |
| --- | --- |
| 起始（任务书核对一致） | `0f5965e0704bc4b3081a87e6f7fd4c331ddd58c9`（= 远端） |
| C1 生产实现 | `66532cb` coverage.ts（共享覆盖判定）+ occupancy/commands/kernel（R1/R2/R3） |
| C2 测试与工具 | `85d1710` harness 配对断点+内核面 reset、共享拦截器、exact oracle、F 矩阵 2 文件、E 纠正、基线回归 |
| C3 文档与非执行证据 | `5af68f8` design §7 / tasks / migration-map §9 / authority-map + baseline + negative-variants |
| C4 预算（清单+脚本） | `cd08cee` 锚点 `5af68f8`，228/1328 |
| **最终验证 HEAD** | `cd08cee1f1ed349e47b6ecb4bec014d6c94265f2`（= final/validation-head.txt = head-after.txt） |
| 预算引用锚点 | `5af68f8bb635ac259a3ee7e94783b3b2f5052409`（不与验证 HEAD 自引用） |
| bundle sha256 | `292f9c73c208a2a149f6f3dd61574b0b7afb7c747ec1f127dc609abd39aefc49` |
| 环境 | node v22.19.0 / npm 10.9.3（final/*.txt） |

## 2. 红灯基线（0f5965e 干净基线，§8.2）

- R1–R3 行为反例：`test/baseline/treasuryRemediationIIBaseline.test.ts` 首跑 **6 failed / 6 total**，全部红在目标语义断言——R1 流出（200 期望 admitted 实际 rejected）、R1 流入（20 同）、R2（真预扣后确认前快照 cursor 期望 1 实际 0、remaining 断言通过）、R3 三态（preflight 期望 invalid 实际 valid）。日志/源码 hash/命令退出码：`baseline/r1-r3-*.log|meta.txt`。修复后 6/6 转绿并保留为持续回归。
- V1–V3 工具契约反例（旧工具形态 scratch 重现器，运行后删除，源码以 patch 文本入库）：**3 failed / 3 total**——V1（reset 分支世界 900 ≠ 断点时刻 1000：效果前 Memory 配效果后世界）、V2（reloadKernel 后旧许可仍 valid：模块注册表未重建）、V3（拦截器卸载恢复旧 descriptor：budgetUsed 0 ≠ 已放行的 2）。`baseline/v1-v3-*.log` + `baseline/v1-v3-scratch-reproducer.patch`。
- 复现均基于真实路径（真执行/真预扣/真许可 + 存储边界拦截），无手填成功证据、无先删记录。

## 3. 实现与验证对应

| 缺口 | 实现 | 验证（断言定位见 test-migration-map §9.2） |
| --- | --- | --- |
| R1 覆盖语义统一 | kernel/coverage.ts 共享锚点链（invocation→external→invocationBoundary）+ 时间序；occupancy/命令/清理门三处消费 | 基线 R1×2、F01（200/201）、F02（20/21）、F03（unknown 200 拒 + 单元锚点对照 + 退出后 200/201）、F17（750/751） |
| R2 预扣同次发布 | prepayReleaseUnitBudget 同次安全写发布 budgetUsed+2 与下一服务位置；确认命令 rotationCursor 删除 | 基线 R2、F04（丢写/单字段篡改/合法对照）、F05（两硬断点：onAllow 捕获处端口调用 0）、F06（恢复续 1/2/3 + 第二切点续 2/3）、F07（同 tick reset 无凭空额度 + 幂等）、F08（重入 cursor ≥4 不回退/缩小回绕/混合 ≤4） |
| R3 preflight 健康门禁 | 非 healthy（absent/incompatible/unhealthy）一律 invalid（可解释 reason、纯读） | 基线 R3×3、F09（facade 路径 fresh/policy/trace/frontier/active 增量 0）、F10（健康对照 + 仅坏 ring 仍可执行 + 克隆零 fresh） |
| V1 断点配对 | captureTreasuryHostBreakpoint 原子捆绑 + 一致性校验（Memory 世界序 ≠ 捆绑值即 throw） | E02 两分支（1000/900）、F11（调用前 800/801）、F12（恢复分支 invocation=null 与旧栈隔离）、F15（早期断点世界 1000、消失结构不复活、伪造断点 toThrow） |
| V2 完整 reset | performTreasuryKernelFullReset（与 service 面共享核心）；jsonRoundtripKernel 降级探针 | E06–E10 循环、F14（旧许可 invalid + 旧对象污染无效 + 探针旧许可仍 valid 的识别锚）、F16=E10 |
| V3 拦截器契约 | 共享 interceptTreasuryCoreWrites（liveValue 卸载 + onAllow 钩子） | E08-3（双义务 cursor=1 + 捕获载荷同次含预算/位置）、F13（卸载前后 Memory 全等、同 tick reset 无凭空额度、正常写后有限完成） |

## 4. 最终验证（HEAD cd08cee，§9.2 模板逐命令成功）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | 零错误 | 0 |
| `npm run build` | 纯本地构建（"No deployment target set. Build only."）；dist/main.js | 0 |
| jest Treasury 定向（src/runtime/treasury/） | **24 suites / 482 tests / 482 passed / 0 failed** | 0 |
| jest Defense 冻结集合（11 文件 + memoryDeclarationBoundaries） | **11 suites / 118 tests / 118 passed / 0 failed** | 0 |
| jest 全仓 | **228 suites / 1328 tests / 1328 passed / 0 failed / 0 pending / 0 todo** | 0 |
| `git diff --check` | 干净 | 0 |
| HEAD 前后一致 / 工作树干净 | validation-head.txt = head-after.txt；status-before/after 均空 | — |
| `node scripts/verify-jest-budget.mjs`（预算提交后） | `JEST_TEST_BUDGET=PASSED`（228/1328） | 0 |

- 定向目录外汇总（§8.5 独立归类）：test/baseline 2 suites / 11 tests（I 基线 5 + II 基线 6）——不计入 Treasury 482。全仓 1328 = 上一轮 1289 + 39（E-kernel +1、E-service +1、F-kernel +16、F-service +15、II 基线 +6）。
- 最坏满载实测（临时探针，同 E19/F18 构造）：**chars=343,817 / bytes=343,817 ≤ 360,000**（本轮无新增持久字段，与 I 轮一致；final/worst-load-probe.txt）。
- F19 引用的既有压力套件包含在全仓 JSON：treasuryKernelStress（10,000 完成生命周期 / 1,000 代 retry 链 / 5,000 混合 unknown）逐文件计数在 jest-full.json 内可提取。

## 5. 关键行为数字（§8.4 要求轨迹）

- F01 固定数值：源 1000→实际流出 800→结果前断点→exact executed→A closing（invocation 空、boundary 在）→新观察 200 下 **200 admitted / 201 rejected**，A 断言时仍在 active；oracle 调用/效果各恰 1。
- F02 流入：空位 100→实际流入 80→新观察 20 下 **20 admitted / 21 rejected**。
- F11 调用前分支：世界 1000 无幻影扣除 → **800 admitted / 801 rejected**；错关联对照 settle 返回 still_uncertain（不盲猜）。
- F05/F06 硬断点：预扣发布内同刻 **budgetUsed=2 + cursor=1 + remaining 不变**；恢复 tick 续 1/2/3（不再调 f0）→cursor=4；第二切点（位置→2）恢复续 2/3。
- E10/F16 混合流量（8 失败工作 + 8 义务 good + 过期 retry + 噪声，逐 tick 完整 reset）：good 在 **40 tick 界内完成**（实测 maxWait < 40，逐 tick 份额 ≤8/调用 ≤4），失败义务保留。
- F17 宿主独立账目：完成 100 + rearm child 50 → 世界 850 = 1000 − 宿主账目合计；长期 unknown（100）保守占用 → **750 admitted / 751 rejected**。
- F09 增量：三态故障下 facade 路径 fresh/policy/动作/frontier/active 全部 **0 增量**（合法 b 执行为基准）。

## 6. 支持模型与未完成项

- 支持范围：受控同步生效测试世界 + 选定断点原子快照后的全运行时重建（Memory+世界+事件三对应）；宿主 ports 闭包与事件日志跨 reset 继承，被测运行时对象/注册表不继承。
- 明确不在本轮：真实 driver 非原子窗口、任意旧备份回滚、整份 Memory 丢失（writer 继续关闭，部署阻断条件不变）；不恢复 Ticket/GRA/Summary/certificate；不新增第二套账本/许可注册表/观察凭证/调度引擎/数据库/在线迁移器；容量与预算未扩大（64/128/360,000/8、worstCase 12 腿、消费者 8、≤9,999）。
- 遗留：无本轮未完成项。生产经济 writer 接入与真实 driver 支持仍为部署阻断条件（非本轮待办）。

## 7. 负向变体（F20）

三个生产负向变体各自**语义断言红灯**（非编译错误）后还原全绿（patch+红日志见 negative-variants/）：
- nv1 旧 occupancy 语义（invocation===null 无条件占用）→ 基线 R1 流出/流入 + F01 红；
- nv2 游标移回回调后（预扣不发布位置）→ 基线 R2 + F05 预扣断点红；
- nv3 preflight healthy-only → 基线 R3×3 + F09 红。
工具契约负向（错配断点/假 reset/恢复旧 descriptor）由 F15（toThrow 断点配对不一致）、F14（探针旧许可仍 valid 的识别锚）、F13（卸载后 Memory 全等）内联承担。

## 8. 纪律声明

- 不部署、不合并 main、未调用真实 writer；Defense 冻结 7 文件生产 diff 为零（jest-defense 11/118 通过；C1–C5 提交未触碰）。
- 未 reset/rebase/force-push/amend 已推送历史；验证后 diff 分类见 §9.3 提交边界（验证 HEAD cd08cee 之后仅非执行证据与本报告）。
- 本报告为 Agent 本地验证；无独立 CI（查询远端 combined status/check runs 见最终报告——无权限或失败将如实保留错误）。
