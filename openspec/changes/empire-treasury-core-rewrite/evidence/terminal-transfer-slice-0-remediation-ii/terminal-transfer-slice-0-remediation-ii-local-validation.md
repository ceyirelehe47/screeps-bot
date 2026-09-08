# Terminal Transfer Slice 0 · Remediation II — 本地验证主报告

任务书：`treasury-terminal-transfer-slice-0-remediation-II-implementation.md`
（验收索引 O01–O06；证据根 `evidence/terminal-transfer-slice-0-remediation-ii/`）。
本文为执行侧主报告；第二上下文结论见 §4 与 revalidation/。

## 0. 提交链与 HEAD 分开

| 角色 | 提交 | 内容 |
| --- | --- | --- |
| 起点（=任务书预期） | `b938a15`（远端核对一致，fetch 后无增量） | Remediation I 交付 |
| 实施提交（预算锚点） | `2099e56` | mock reconcile 归集/全量分离 + 协调器固定路线 + O 文件 4 it + M05/M07 投影断言 + openspec 三文档 + baseline 证据 |
| 预算提交 = **VALIDATION_HEAD** | `fc5edf3` | budget manifest/脚本锚点滚动（239/1440，基线 2099e56） |
| 归档提交（交付 HEAD） | `<本报告归档提交>` | final/revalidation/ 证据 + 主报告 |

主验证运行于 `fc5edf3`（干净工作树）；归档只追加非执行性内容。

## 1. O01–O06 结论

| 索引 | 结论 | 承担位置 |
| --- | --- | --- |
| O01 | PASS | `treasuryTerminalTransferSlice0RemediationII.test.ts` it1：函数级两种排列顺序均 uncertain；注册路径 a（injected 两视图）/b（仅 outgoing）/c（仅 incoming）经 `settleUnknownOutcome` 均 still_uncertain、phase=outcome_unknown、active 保留、submits 前后计数不变；对照（无注入）ok/committed |
| O02 | PASS | 同文件 it2：唯一 100 committed；只有相关 60 uncertain；不同 ID 100+60 uncertain；两个 100 uncertain；同 ID 100/60 矛盾 uncertain；唯一 100+不同关联键无关 60 committed（注册路径含 closing→退出）；注册路径只有 60（未处理）uncertain+责任保留、同 ID 矛盾镜像 uncertain；N01/N02 既有归属回归保留（主验证 jest-slice0 全绿） |
| O03 | PASS | 同文件 it3：四间受管辖健康房间，C→D/D→C/A→D/C→B 均 rejected(stage=route) 且理由匹配"路线不在本场景范围"（明确排除关窗/在途/资源/容量/冷却/结构兜底词）、active 数不变、submit 增量 0；显式 A→B 完整闭环；默认（省略）A→B 越冷却后完整闭环；终态源 800H/10000−2q/目标 200H/submits=2 |
| O04 | PASS（实测通过、生产零改动、无 ADAPTER_GAP） | 同文件 it4 + `treasuryTerminalTransferSlice0.test.ts` M05/M07a/M07b 的 projection() 断言：unknown 保守占用（observed 1000/10000、committed 100/q、spendable 900/10000−q、容量 F0−100）→ closing 不双扣（observed 900/10000−q、committed 0/0、spendable 900/10000−q、容量 F0−100 非 F0−200）→ 退出后数值一致（不重复释放）→ 物理终态与恰一次提交；M07b 恢复 tick blockers 恰为 `["lifecycle_closed"]`（C06 已关窗口语义如实呈现，账目数字仍真实——非 fail-closed 的 0） |
| O05 | PASS | 主验证：三组冻结 diff（production/config/defense）全 0；jest-key 8/77（N03/N05/N06 回归在内）、jest-treasury 35/594、jest-full 239/1440 全绿；verify-evidence PASS + 仓库外含空格 cwd 正例 0；无新增持久权威（lastQuote 已不存在、无 retryFacts——N06 既有断言） |
| O06 | PASS | 固定 SHA fc5edf3 主验证（final/ 全套 6.6M：五组 Jest JSON+log+exit+command、三组冻结、typecheck×2、build、bundle-sha256、budget、verify-evidence/outside/empty/noargs/tampered、四组 trace、changes-this-round、run-mainval.sh+sha256+mainval-run.log 哨兵）；第二干净上下文定向复验（§4/revalidation/）；预算锚点 2099e56 与验证 HEAD fc5edf3 分开；原型限定结论与真实引擎未实测边界分开（§5） |

三类问题分开报告：**A**（归集/全量耦合）为已运行过函数级反例的实现缺口——本轮经注册 settle 路径在起点复现（基线 R-A 误报 committed）并修复；**B**（固定路线）为待仓库确认的入口缺口——本轮实跑证实（基线 R-B admitted 且 submits=1）并修复；**C**（closing 投影）为验收欠项——实测通过、生产零改动，不称生产故障，无 ADAPTER_GAP。

## 2. 三项工作实施摘要

- **工作 A（§3）**：`ownershipMatch` 拆出 `relatedMatch`（不含 amount——描述/路线/双方/资源/order 排除全来自持久 payload v2）；归并/一致性/时点窗/唯一性流程不变，唯一性之后新增 4b 全量完成条件 `matched.amount !== payload.a → still_uncertain`。结果表六行全部实测（§1 O02）。不把 100+60 相加、不挑最像、不补发 40、不报 not_executed、无 TTL 删除。adapter version/semanticIdentity 不变（筛选顺序修正不改变证据语义；旧 payload/旧身份不被解释为更强证明）。
- **工作 B（§4）**：协调器 `requestTransfer` 在单条在途检查之后、准备之前新增固定路线检查——省略用 `W1N57→W10N57`（FIXED_* 常量）、显式相同接受、任一端点不同 `rejected(stage="route")` 不准备不构建不接纳；运行时不静默改默认路线。通用 facade/kernel 多房间能力不变（低层夹具 C/D 直连反例保留——M04 场景外目标用例不受影响）。
- **工作 C（§5）**：新增 `projection()`/`queryRoom()` 断言口径——`service.query` 限定单房间 terminal、allowProjected/allowIncoming=false、subtractOutgoing/subtractReservations=true、withhold=0；目标 `riskAdjustedFreeCapacity(B,"terminal")`。数字表与机制见短报告 §4（closing-committed 占用释放由共享锚点链+观察世界序判定——occupancy.ts 只读核对）。接入 M05（unknown+closing+退出三段）、M07a/M07b（恢复后 unknown+closing 两段各两处）。未传 owner（ownerStatus="none"、resolveOwnerStatus 对 undefined 返回 valid=true——spendable 按真实占用计算）。

## 3. 主验证（fc5edf3，干净工作树，离线）

全部退出码与数字见 final/README.md 汇总表：冻结 0/0/0、typecheck×2 0、build 0（bundle sha256 b251d0f7… 仅产物追溯）、jest-slice0 3/20、jest-key 8/77、jest-treasury 35/594、jest-defense 11/118、jest-full 239/1440（failed/pending/todo 全 0）、budget PASSED（239/1440）、verify-evidence PASS、verify-outside（仓库外含空格 cwd）0、补负例 empty=1/noargs=2/tampered=1（篡改点 doc.fixture.unknownIds[0]，检出信息精确）、diff-check 0、前后状态干净、head 前后一致、哨兵 MAIN_VALIDATION_DONE + wrapper exit 0。

基线（b938a15 隔离 worktree）：3/3 复现（R-A 误报 committed / R-A 对照 committed / R-B admitted+submits=1）；修复后退化对照——同一基线文件在修复树实跑 R-A 转 still_uncertain 红、R-B 转 rejected 红、对照保持绿（任务书 §6：起点行为+修复后预期即目标退化对照，不另建变异驱动）。

## 4. 第二干净上下文定向复验

独立 reviewer subagent（独立上下文，非同执行者第二树）：固定提交 fc5edf3
的隔离 worktree + node_modules junction，离线、主树只读、未 push。结果
**PASS**：tsc 0；定向 Jest 8 suites/77 tests（slice0 子集 3/20，与主验证
final/jest-key.json、final/README.md、驱动输出三方互证一致）；Defense
11/118；核验驱动仓库外含空格 cwd 正例 0（TREASURY_EVIDENCE_VERIFY=PASS，
H18-J06.json 1,180,356 字节/54 checkpoints/problems=0）、空输入 1、缺参 2；
三文件（prototype/coordinator/驱动）blob 与 sha256 在固定提交、主树工作
树、worktree 工作树、主验证日志四方互证一致（driver 3b5e9464…）；
复验 worktree 用后即删。异常三条如实留痕（revalidation/README.md）：
① 指令文本两处笔误（双重 treasury/ 路径与"9/89"期望——实际 8 文件/77
tests，reviewer 修正后运行且与主验证互证）；② 清理后 worktree list 仍有
主执行者基线 worktree（复验未创建，归档后统一移除）；③ 复验期间主树
untracked 因归档进行中增多（预期内）。

## 5. 未证明边界（结论分开）

- 本轮全部为**测试专用调拨原型的限定修复**：W1N57→W10N57/100 H 是夹具值，不是已批准的正式服业务路线或额度；C/D 房间只作反例噪声。
- **真实引擎边界未实测**：fake 宿主按固定 engine 源码（8097782）三段语义建模；真实环境费用/冷却/缩量/交易记录窗口行为、`Game.market` 并发与 PTR/正式服行为本轮未运行任何真实服务器或经济 writer 验证。
- 生产内核/门禁冻结继续有效（主验证三组冻结 diff 亲跑 0）；O04 只读核对生产占用投影语义，未改动生产任何文件。
- lifecycle_closed 在 endTick 后断点的恢复 tick 是既定 C06 语义（已关窗口不得重开），不是缺陷；账目数字仍按真实占用计算。

## 6. Git 纪律与 CI

- 3 个提交线性（b938a15 → 2099e56 → fc5edf3 → 归档提交），无 reset/rebase/force push/merge main；2099e56 的 message 修正在**推送前** amend（任务书禁止的是 amend 已推送提交）。
- 归档前后 `git diff --check`/`git status --short` 干净；push 后 `git ls-remote` 核对远端 HEAD（见 §0 表与归档提交后记录）。
- CI：push 后查询 check-runs/statuses，空结果如实标"无 CI证据"。

## 7. 验收结论

O01–O06 全部交付（§1）；沿留待办两项低危记入 tasks.md（O01 函数级顺序变体只覆盖 injected 列表两种排列——宿主记录与注入记录在视图拼接中的先后由 mock 固定；M06 部分量 fee 显式断言沿上轮）。本轮通过只结束这份离线补修，不自动授权启动服务器、上传脚本或真实转运。
