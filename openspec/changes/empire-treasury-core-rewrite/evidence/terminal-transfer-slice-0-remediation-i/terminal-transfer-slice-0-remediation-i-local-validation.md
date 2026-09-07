# Terminal Transfer Slice 0 · Remediation I——本地验证主报告

任务书：`treasury-terminal-transfer-slice-0-remediation-I-implementation.md`（N01–N08）。
日期：2026-09-07。分支 `refactor/empire-treasury-rearchitecture`。

## 0. 提交链与验证 HEAD

| 提交 | 内容 |
| --- | --- |
| `93a6152` | 起点（上轮交付 HEAD；本地=远端核对一致、工作树干净） |
| `9a83520` | 执行性变更：mock v2（归属/冻结费用/分视图注入）+ 协调器（单条在途）+ M 改造 + N 反例 8 it + T1 驱动 + openspec 三文档 + baseline/ 与 controls/ 证据 |
| `4ea56d0` | 预算锚点滚动（238/1436，基线 9a83520）——**VALIDATION_HEAD（主验证与第二上下文固定于此）** |
| （归档提交） | final/ + revalidation/ + 本报告 + 验收结论（后置仅日志/数据/文档） |

主验证产物：`final/`（run-mainval.sh 原件 sha256 1e41d571…、mainval-run.log 哨兵 MAIN_VALIDATION_DONE、全部命令/退出码/日志/JSON/trace）；基线：`baseline/`（起点 worktree 实跑 7/7 原件 .ts.txt 与还原命令）；退化敏感性：`controls/mutation-{1-ownership,2-gate,3-fee}.txt`。

## 1. N01–N08 结论

| 索引 | 结论 | 证据 |
| --- | --- | --- |
| N01 | **PASS** | 基线 R1a/R1b 实跑误报 committed（baseline-run.log）；修复后函数级矩阵逐项破坏（前缀/后缀碰撞、sender/recipient 错与缺失、from/to 错、resource/amount、旧 v1 payload、无记录/dropAll/读异常）全 uncertain、正确对照 committed（N01 it）；期望值全部来自持久 payload v2 |
| N02 | **PASS** | 同 ID 一致镜像归并（两视图/同视图重复）、镜像矛盾两方向顺序无关拒绝、仅描述/仅时点矛盾拒绝、旧记录不认领且与正确记录并存时正确完成、当前 tick 不结算、多 ID/带 order 保守且不阻断；注册 settle 路径 C→D 错路线（C/D 数值吻合）/镜像矛盾/双方错保持 outcome_unknown+active 保留、正确对照 committed→closing→退出（N02 + N01/N02 两 it） |
| N03 | **PASS** | 基线 R2 实跑第二许可；修复后 B（不同 workKey/关联键）经第二协调器 single-flight 拒（理由含"单条在途"、不含窗口/额度）+ facade 直连对照（入口边界）；完整 reset 到开放 tick 仍拒、A 退出后 B 接纳；A closing 阻断、退出并越过 10 tick 冷却后 B 完整闭环（submits=2、源 800H、fee×2、目标 200H）（N03 ×3 it） |
| N04 | **PASS** | 原 M05 延迟闭环与两类配对断点经业务入口（coordinator.requestTransfer/executeTransfer）实际重跑（M05/N04、M07/N03/N04 ×2）；当 tick 未处理不释放、正确记录到达结算、cleanup 退出、恰一次提交不双扣 |
| N05 | **PASS** | 基线 R3 实跑（刷新后接受/未查询端口被调）；修复后六场景：(a) 前检拒（许可未消费 pending 保留）→恢复报价完成闭环（实际费用=q）；(b) 再查询多次仍拒；(c) 另一准备报价+直连 facade 到 adapter guard（零提交、unknown 保留、settle uncertain）；(d) 报价读异常；(e) 非法值；(f) 独立场景 q+5 新请求闭环（实际费用=q+5）。全部"零提交"以 host.submits.length 直接断言 |
| N06 | **PASS** | durableFacts/derivePostings 重复派生恒等（纯函数，R7）；permit.postings/active worstCase/持久 payload/canonical 冻结 q 同源；重复授权同一持久事实；drift+再报价不回填；无 retryFacts；协调器无内部状态（N06 it + M03 默认装配断言） |
| N07 | **PASS** | 驱动 resolveRepoRoot 脚本路径定位（git 显式 cwd、typescript 锚定、run-dir 按调用者 cwd 解析并打印 repo-root/run-dir-resolved）；主验证 verify-outside（仓库外**含空格** foreign cwd/ 绝对路径，exit 0 PASS）/verify-empty（exit 1）/verify-tampered（篡改 unknownIds[0] exit 1，失败原因精确）；缺参 exit 2（驱动 usage(2)，见上轮自测与本轮冒烟）；三项退化变异（controls/）各使目标 it 红、还原无残留；驱动与自测先提交（9a83520）后在 4ea56d0 运行 |
| N08 | **PASS** | 固定 SHA 4ea56d0 主验证全套（final/）+ 第二干净上下文定向复验（revalidation/，见 §4）；生产/配置/Defense 冻结三组 diff 0；原始日志/JSON/小型轨迹齐全；本报告限定范围（§5） |

## 2. 三项工作与基线摘要

- **基线（§3）**：起点隔离 worktree（93a6152 + node_modules junction）实跑 7/7——R1a-d（错误归属四型经注册 settle 误报 committed；正确对照 committed 证明其余成功条件成立）、R2（不同 workKey 第二许可）、R3（lastQuote 刷新后陈旧预算被接受；未查询分支端口已被调用）。原件/命令/日志/sha256 归档 baseline/。
- **工作 A（归属）**：canonical 一次取值（prepareSlice0TransferArgs：q/tick/基线）→ 派生纯函数（build 与 buildIdentityFacts 重复派生恒等）；payload v2（k/s/d/a/f/sb/tb/t/u；version 2+semanticIdentity v2，旧 v1 不静默升级）；reconcile 完整描述严格相等 + 同 ID 全部副本先验一致性（顺序无关）+ 时点窗（t≤time<Game.time：旧记录不认领、当前 tick 不结算）+ 库存只查期望端点 + 多 ID/无记录/部分量/order/读异常保守 + 永不 not_executed。
- **工作 B（单条在途）**：test/mock/treasuryTerminalTransferCoordinator.ts——门禁从 kernelJournal() 持久 active 读出（identity.actionKind 匹配；不同 workKey 也拒；closing/retry_ready 占用；absent=kernel store 惰性初始化的真实空态放行，unhealthy/incompatible fail-closed）；协调器无内部可变状态（跨实例/跨完整 reset）；入口边界以 facade 直连对照在测试中注明。
- **工作 C（冻结费用）**：lastQuote 全移除（报价端口只读）；verifySlice0FeeQuote 纯比较共享业务前检（许可未消费拒）与 adapter guard（submit 端口调用前拒）；报价读异常/非法值零提交；drift 不回填旧 permit/active/durable；submit 端口还原宿主语义；自动重试仍关闭。
- **T1**：见 N07。

## 3. 主验证摘要（4ea56d0）

冻结三组 diff 0（production 869149d..4ea56d0 src 非 test 零差异 / config 五件零差异 / Defense 七件零差异）；typecheck ×2 = 0；build = 0；bundle sha256 fe8f2bd6…（产物追溯）；Jest：slice0 2/16、key 7/73、treasury 34/590、defense 11/118、full 238/1436（failed/pending/todo/runtime error 全 0）；budget JEST_TEST_BUDGET=PASSED（238/1436；自带全仓重跑单列于 budget.log）；verify-evidence PASS（trace 四目录 + 四 Jest JSON、固定 H18 夹具）；verify-outside（含空格外部 cwd）exit 0 PASS / verify-empty exit 1 / verify-tampered exit 1（篡改检出）；diff-check 0；status-before/after 0 行；head-after=4ea56d0。

## 4. 第二干净上下文定向复验

独立 reviewer subagent（未参与实施）在固定 `4ea56d0` 的独立干净 worktree + 独立 npm ci（896 包）：**全部 10 步 PASS、无期望外失败**。冻结三组 diff 0/0/0；typecheck 0；NM 2/16/16；KEY 7/73/73（H18-J06.json 54 checkpoints problems=0）；Defense 11/118/118；cwd 三态（含空格外目录正例 exit 0 PASS / 空输入 exit 1 / 缺参 exit 2）——T1 修复在第二上下文实测有效；三文件 sha256（mock/coordinator/驱动）worktree=HEAD blob=主树全一致（driver 3b5e9464…）；复验后 worktree 删除、主树无改动。reviewer 过程异常 6 条均不影响结论且如实留痕（sha 误打 fallback、指令措辞、路径确认、并行归档观察、基线 worktree 保留项、过程小失误），产物见 revalidation/。

## 5. 未证明边界与停止

- 本轮全部验证离线：Jest/ts-jest/驱动均不联网；未部署、未上传游戏代码、未启动任何真实游戏服务器、未调用真实 terminal.send()/Game.market.deal() 或其他经济 writer；未使用正式账号/PTR/私服/玩家 Memory 或凭证。
- fake 宿主是固定 engine 源码（8097782）语义的离线建模，不是真实引擎运行证据；真实环境待实测项仍见 terminal-transfer-slice-0.md §1.5/§3（后续隔离引擎实验继续只准备不执行，未获单独授权）。
- 100 H 是测试夹具值；C/D 房间仅错路线反例噪声。无 ADAPTER_GAP：三项缺口均在测试原型接口内表达（canonical prepared 事实 + payload v2 + 协调器）。
- 生产内核/配置/Defense 冻结经主验证独立确认继续有效。本轮通过只结束这份离线补修，不授权启动服务器、上传脚本或真实转运（任务书 §10）。

## 6. git 交付

- 提交链 93a6152 → 9a83520（执行性）→ 4ea56d0（预算，VALIDATION_HEAD）→ 归档提交（仅 evidence/文档，后置可运行脚本已在固定提交中：run-mainval.sh 为命令实录原件非判定脚本，判定用驱动 verify-treasury-evidence.mjs 与预算脚本均在 4ea56d0）。
- 无 reset/rebase/force push/amend 已推送提交；不合并 main。归档前后 git diff --check / status / log 核对见 final/ 与收尾记录。

## 7. 独立验收

2026-09-07 Agent 独立验收结论：**ACCEPT**（N01–N08 全 PASS）。要点：基线在起点 93a6152 亲跑复现 7/7 且 sha256 吻合；reconcile 期望值全部来自 payload、无 matched 反推通道（库存核对读 payload.s/d）；协调器门禁从持久 active 读出、closed 即 delete 佐证"不过滤 phase"正确、absent 放行有 kernel/store.ts 惰性初始化依据；主验证五组 Jest JSON 数字亲解析（2/16、7/73、34/590、11/118、238/1436）＋budget PASSED＋退出码亲核；M+N 16/16 亲跑复现；三组冻结 diff 亲跑 0/0/0；驱动缺参（含空格外目录）亲跑 exit 2；三份变异原件证明注入真实破坏对应防护且目标 it 以行为差异失败（非抛错假红）；§10 正向链路（准备→接纳→真许可执行→假宿主延迟处理→注册对账→cleanup 退出 100H）在四个独立用例走通、三类错误分别挡在归属核对/single-flight+前检/guard 边界；旧报告勘误三条逐条对照 93a6152 旧实现属实；git reflog 纯 commit 链、无 reset/rebase。

CONCERN 3 低全处置：C1（文档任务书文件名）经核实**不成立**——三处引用本为完整正确文件名（验收转述缩略所致），task/task-brief.md sha256 链完整；C2（勘误 1 措辞过宽）已收敛为"sender/recipient 不参与归属身份比对、时点无下界窗、同 ID 一致性比对不含 order/description/时点"（纯文档）；C3（final/ 无独立 noargs 退出码文件）已补注证据位置（revalidation/verify-noargs.log 与本节亲跑记录；§9 模板未要求 final 自包含）。均为文档级处置，不触及可执行代码，无需重新固定验证。

本验收不构成部署许可；生产冻结经亲跑独立确认继续有效。
