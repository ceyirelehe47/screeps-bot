# Terminal Transfer Slice 0 — 本地验证主报告

任务身份：**Terminal Transfer Slice 0**（验收索引 M01–M08）。任务书 SHA-256 `1d1d835376fb95b5c897511070024085f971b578ab7d05efd96daf15ad6f55f5`（三方一致：Downloads 原文、`evidence/terminal-transfer-slice-0/task/task-brief.md`、reviewer 复算）。

| 项目 | 值 |
| --- | --- |
| 实施起点 | `1b1279ff7161ffc6f2bee31daec1c3fe619184da`（= 编制时远端 HEAD，fetch 核对无增量） |
| 生产冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 测试/驱动提交 | `44aae6142b6dad80a53511448bbccb5c242a1940` |
| 预算锚点提交 | 同上（manifest/脚本滚动提交 `0ce9d971bcf72daf19a1fe68fd7bb384e4db56fe`） |
| **VALIDATION_HEAD** | `0ce9d971bcf72daf19a1fe68fd7bb384e4db56fe` |
| 上一预算锚点 | `5360e666…`（236/1420）→ 本轮 `44aae61…`（**237/1428**） |
| 全仓原始结果 | 237 suites / 1428 tests / 1428 passed（失败/pending/todo/runtime error 全 0） |
| 定向结果 | KEY 六件 6/65；Treasury 33/582；Defense 11/118（集合可重叠，不累加） |
| 交付 HEAD | 见本仓库交付回复（本报告与证据归档提交之后的 HEAD） |

## 1. 三项工作的结论

### 工作 A（核验脚本一次性收尾，M01）——完成

`scripts/verify-treasury-evidence.mjs`（提交于 44aae61，先于验证固定）整合上轮三个后置 `.mjs` 的现有调用：trace 核验（git show 固定提交 helper → transpile → `sealVerifyTraceCompleteness`）、Jest JSON 失败检查、递归 walk；去除硬编码临时路径，显式 `--validation-head/--run-dir/--fixture`。**expected 改用固定夹具约束**（H18：20 个指定 unknown `tk1_h18_30..49`、12 观察窗口）且校验待检文件与约束一致——不再把待检文件自带的 `fixture.unknownIds/actualTicks` 当 expected（任务书 §2 明令）。旧原件与日志保留历史身份未改写。自测三组实跑（final/）：正例（上轮归档产物，输入 hash 固定）exit 0；零输入 exit 1；篡改（checkpoint unknownRisk 置 null）exit 1 且报告"风险证据缺失"。主验证 `verify-evidence` 对本轮四份 trace + 四份 Jest JSON exit 0。**上轮遗留的"后置可执行核验脚本交付纪律"保留项就此关闭**；未复跑历史实验（任务书 §2 明示不为旧驱动重跑每轮历史）。

### 工作 B（真实引擎契约核对，M02）——完成

固定 SHA `8097782`（engine）+ `cf63d8a`（driver）十个文件逐文件核对（副本+SHA-256 在 `sources/`）。短报告按四列（源码事实/官方文档/原型假设/待实测）写入 `openspec/…/terminal-transfer-slice-0.md` §1，回答任务书五问。关键差异已固化进原型与测试：OK 仅调度、处理层静默丢弃无记录、**executeTransfer 按目标剩余空间缩量并按实际量继续**（100 请求可只转运 60，费用按缩量后重算，记录仍插入实际量）、效果与记录最早 T+1 可见、交易两视图同 `_id` 同事实、runner 中 Memory/intents 并行保存（异常顺序待实测）。

### 工作 C（测试专用 adapter 原型，M03–M07）——完成，无 ADAPTER_GAP

`test/mock/treasuryTerminalTransferPrototype.ts` + `src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts`（8 it 全绿）。要点：`settlesOnAccept=false`/`nonOkOutcome="unknown"`；canonical 参数单一来源（三腿 postings/结构绑定/durable facts/描述关联键同源派生，fee 从报价端口派生并冻结、漂移拒绝）；fake 宿主三段建模（API 检查链+pending 化/处理层重查+缩量与静默丢弃/公开形态交易视图），宿主状态工厂闭包跨 reset 存活、断点配对复用 harness `treasury-journal-branch` 形状（adapter 暴露 `journal=host` 过来源关联核实）；reconcile 只收公开形态证据（交易视图+世界读取+durable 基线）、**永不返回 observed_not_executed**（无记录不能证明未执行）；部分量不报全量不补发不重执行；同 workKey 排他从持久 active 读出、跨断点重载成立；恢复后新接纳经新模块构建入口（resetModules 边界固化为测试注释）。生产 kernel/facade/actionContracts/coverage/observation/testHarness/装配/配置/lockfile/Defense **零改动**（三组冻结 diff exit 0）。

## 2. M01–M08 逐项状态

| 索引 | 状态 | 依据 |
| --- | --- | --- |
| M01 | ✅ | 驱动提交于 44aae61 并在 0ce9d97 实跑（final/ 全套 + 自测三组）；旧脚本保留历史身份；未重写风险 helper（复用 `sealVerifyTraceCompleteness`） |
| M02 | ✅ | terminal-transfer-slice-0.md §1 四列短报告 + sources/ 源码副本（十文件 SHA-256）；开源版本不冒充正式服版本（明示） |
| M03 | ✅ | it「M03」（默认注册表无 kind、canonical 三处一致）+ 三组冻结 diff exit 0（生产/配置/Defense 零差异、无默认注册、无网络发送能力——execute 只调注入端口） |
| M04 | ✅ | it×2：正常 100H+fee 接纳执行为 unknown；降 H/降费用能源/目标空位/结构替换拒绝且提交增量 0；amount/resource/关联键/场景外目标拒绝；恢复后成功 |
| M05 | ✅ | it「M05」：当 tick 仍 unknown 且责任保留；处理+新观察后结算退出；源 900H/energy−fee、目标 +100H、恰一次提交、不双扣、退出后无重放 |
| M06 | ✅ | it×2：无记录/窗口挤出/读异常/他人记录/市场订单/重复交易 ID/部分量 60 全部不报全量、不补发、不重执行；两视图同 ID 单次计数；正确唯一记录对照完成 |
| M07 | ✅ | it×2：提交后结果持久化前（execute 内捕获）与已接受未处理（endTick 后）断点——`performTreasuryFullReset` 配对重载（宿主 branch reopen）；先 unknown 后事实到达收尾；旧许可拒绝；同 workKey 不重发（排他从持久 active 读出）；未知时第二需求阻断、结算完成后解除 |
| M08 | ✅ | 主验证（0ce9d97 全套）+ 第二上下文独立 reviewer（worktree+npm ci，M 8/8、KEY 6/65、Defense 11/118、驱动三组、冻结/typecheck 0、hash 三方一致）；后续实验说明（terminal-transfer-slice-0.md §3）只准备未执行 |

## 3. 主验证摘要（0ce9d97）

冻结三组 exit 0 / typecheck×2 exit 0 / build exit 0（bundle `1ef35d7f…`）/ KEY 6/65 / Treasury 33/582 / Defense 11/118 / 全仓 **237/1428** / budget `PASSED`（自带重跑独立标注）/ verify-evidence exit 0 / 驱动自测三组符合预期 / diff-check 通过 / HEAD 未动 / 前后 status 干净。**事件**：首跑因验证 bash 脚本参数笔误在篡改环节中断（副本未篡改、驱动正确返回 0、断言按预期失败）——尾段修正参数重跑全过（篡改 sha256 `2b4ce575…`、驱动 exit 1 报风险证据缺失）；全程如实归档（final/ 事件记录节）。变更分类：869149d..0ce9d97 全部差异为 `src/**/*slice0*.test.ts`、`test/mock/treasuryTerminalTransferPrototype.ts`、`scripts/verify-treasury-evidence.mjs`、`scripts/verify-jest-budget.mjs`（锚点滚动）、`test/test-suite-budget.json`、openspec 文档与 evidence（`changes-from-freeze.txt`/`changes-scripts-test.txt`）——无生产代码进入豁免目录。

## 4. 第二上下文（revalidation/）

未参与实施的独立 reviewer subagent 于独立 worktree（0ce9d97、npm ci 896 包、独立 cache/输出）复跑：typecheck 0、两组冻结 0、M 8/8、KEY 6/65、Defense 11/118、驱动正例 0/零输入 1/缺参 2、任务书 hash 一致、worktree 前后干净用后即删、主树只读。异常 A1（reviewer 指令文件的路径措辞与驱动 run-dir 契约不符）已由 reviewer 按任务书 §7.2 模板布局处置并双重留痕（attempt1 产物 + run-key 重跑），不构成对被验提交的否定。

## 5. 未证明边界（不夸大）

- 原型与全部 M 测试运行在**本地 fake 宿主模型**（离线 Jest），不是真实引擎执行证据；源码阅读不等于真实引擎实跑。
- 真实 engine/driver 的中断与持久化关系（runner 并行保存、CPU 终止、global reset 后视图可见性、交易历史窗口实际大小、正式服与固定 SHA 差异）**均未实测**——清单见 terminal-transfer-slice-0.md §1.5。
- 关联键唯一性范围=隔离测试 run；真实环境适配前置条件见 §2.3（不宣称天然永久唯一）。
- 100 H 与无 Power 是原型夹具值，不是已批准的正式服额度。
- 不宣称 exactly-once 或真实 Screeps CPU 保证；本轮不授予部署许可、不接真实 writer。

## 6. 交付与 Git

- 本轮提交链（线性，不 reset/rebase/force/amend，不合并 main）：`1b1279f`（起点）→ `44aae61`（test：驱动+mock+8 it+openspec 文档+task/sources 归档）→ `0ce9d97`（chore(budget)：锚点 237/1428）→ 证据归档提交（本报告与 final/revalidation/controls 产物；交付 HEAD 见交付回复）。
- 归档物含两份验证期 bash 驱动原件（`run-mainval.sh`/`tail-rerun.sh`）与 reviewer 指令原件——均为**验证时实际驱动脚本/说明的留痕**（仓库外编写、非提交物、非 Jest 收集对象、不参与构建；对应任务书"验证后只追加日志/数据/说明"的边界，此说明即为该边界的适用记录）。
- push 在独立验收（见 §7）结论落地后执行；`git ls-remote` 核对远端一致；CI 查询空结果将如实标"无 CI 证据"。

## 7. 独立验收（补记）

未参与实施的独立验收 subagent（只读审查+亲跑）结论：**ACCEPT**，M01–M08 全 PASS。要点：驱动固定夹具约束经亲跑证实（正例 exit 0/缺参 exit 2；expected 来自 FIXTURES.h18 常量而非待检文件值）；三份源码副本与 GitHub 固定 SHA 逐字节一致、短报告四列如实；三组冻结 diff 亲跑 exit 0、src/ 无 slice0 生产引用；8 it 断言语义逐条审查为真实（fee 精确到报价端口实值、部分量 60 非永真、排他断言到拒绝理由、恢复经新模块入口）并亲跑 8/8；归档 140 件完整自洽（四组 Jest JSON 数字复核、预算三方一致、A1 异常双重留痕）；git 纪律与任务书 hash 符合。CONCERN 3 条均为低级已处置：C1（M04 负向场景补 submits===0 断言）/C2（M03 断言改不清空直接 find）记入 tasks.md 沿留待办（改可执行测试须重新固定验证，不在归档边界内追加）；C3（controls 目录措辞）已补定位说明（负向原件并入 final/selftest）。验收不构成部署许可；生产冻结经亲跑独立确认继续有效。结论全文见 tasks.md Terminal Transfer Slice 0 段末两行。
