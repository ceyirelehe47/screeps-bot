# Terminal Transfer Slice 0 · Remediation I——完整交易归属、单条在途与冻结费用

任务书：`treasury-terminal-transfer-slice-0-remediation-I-implementation.md`（验收索引 N01–N08）。
起点 `93a6152`（上轮交付 HEAD）；本轮修正对象是**测试专用调拨原型**，不是通用内核；生产/配置/Defense 冻结继续有效（主验证三组 diff 承担）。

## 1. 基线与修复对照（起点 93a6152 实跑复现）

基线在起点隔离 worktree 实跑（7/7 全部复现，原件与日志见
`evidence/terminal-transfer-slice-0-remediation-i/baseline/`，`.ts.txt` 含还原命令；

| 缺陷 | 基线行为（实跑） | 修复 | 验证位置 |
| --- | --- | --- | --- |
| R1 归属反推：`description.includes(k)` 匹配、库存核对用 `matched.from/to`、镜像比对不含 description/time/sender/order | 错误关联键（含期望键前缀）、错误双方/身份缺失、A→B 认领 C→D 记录（C/D 数值吻合、A/B 不变）、同 ID 镜像描述矛盾——全部经注册 settle 路径误报 `observed_committed`；正确记录对照同样 committed（证明其余成功条件成立） | 期望值全部来自持久 payload v2（一次取值），不从候选记录反推；完整描述确定编码严格相等；库存只查期望端点；同 ID 全部副本先验一致性（顺序无关）再归并 | N01/N02（函数级矩阵 + 注册路径 phase 断言） |
| R2 无单条在途：kernel 只有 `sameWorkKeyActive` | 不同 workKey、不同关联键的 B 在 A（outcome_unknown）未结束时仍被接纳（拿到第二张许可） | 测试专用业务协调器：`kernelJournal()` 只读视图的 active 中存在本原型动作未结束记录即拒绝（不以 workKey 相同为前提；closed 不落盘不占用；历史 ring 不算在途） | N03（跨协调器/跨完整 reset 到开放 tick/closing 三个 it） |
| R3 lastQuote 可刷新：submit 与"最后一次报价"比对 | 冻结报价涨 5 后再查询一次，旧请求以陈旧预算被接受进入 submit（pending=1）；未查询分支虽被拒但 submit 端口已被调用一次（比较发生在调用之后） | 移除 lastQuote 权威：canonical 冻结 q（准备时一次取值）+ 业务前检与 adapter guard 共享 `verifySlice0FeeQuote` 纯比较，在调用 submit 端口**之前**拒绝；报价读异常/非法值同样零提交 | N05（六场景 + 双覆盖 + 闭环对照） |

## 2. 完整交易归属（工作 A）

### 2.1 期望值先存在（canonical 一次取值）

`prepareSlice0TransferArgs(host, source, target, key)` 在准备时一次读取：可信报价端口的
q、准备时 tick、源/目标余额基线——形成不可变 `prepared` 事实进入 canonical args。此后
`derivePostings`/`durableFacts`/`structureBindings` 是**纯函数**：build 与 authorize 的
`buildIdentityFacts` 重复派生（facade.ts:739 与 actionContracts.ts:976 两处调用点）得到
恒等输出，digest、postings 与持久事实始终代表同一准备时刻（R7）。业务路径只经该函数
形成 canonical——手填更低费用的调用者在执行前复验处被拦（低层隔离用例除外，见 §3
入口边界）。

### 2.2 payload v2（协议升级，不静默迁移）

```
v2|k:<关联键>|s:<源房>|d:<目标房>|a:<全量>|f:<冻结q>|sb:<源H>,<源E>|tb:<目标H>|t:<准备tick>|u:<合成用户>
```

受控可打印字符集（kernel `PAYLOAD_PATTERN` 排除 `"` 与 `\`——沿用非 JSON 编码）。
adapter `version: 2`、`semanticIdentity: "slice0.terminal-send@engine-delayed-transfer-v2"`：
旧 v1 identity 的记录不会被新 reconciler 静默认领（facade 按 identity 匹配，不匹配保持
unknown）；旧 v1 payload 解码失败 → `still_uncertain`，不猜测补齐身份（N01 有专测）。

### 2.3 reconcile 算法（期望全部来自持久 payload）

1. 读两交易视图（任一异常 → `still_uncertain`）；
2. 按交易 ID 分组（两视图合并；同视图重复也在组内）；
3. **相关组**＝组内任一副本完整归属匹配（完整描述严格相等 && from/to === payload 路线 &&
   sender/recipient.username === payload.u && resourceType === "H" && 无 order && amount ===
   payload.a）；相关组先验**全部副本一致性**（描述/双方/身份/路线/资源/金额/时点/order
   属性逐项——顺序无关，不能把矛盾镜像先过滤掉），矛盾整体阻断，一致归并为一条；
   无关键录（他人交易/市场订单/无关噪声）不阻断正确唯一记录；
4. 时点窗：`payload.t <= time < Game.time`——早于准备 tick 的旧记录不认领（与正确记录
   并存时正确记录仍完成）；当前 tick 记录（time === Game.time）单纯刷新观察不结算；
5. 窗内候选 ≠ 1（零或多 ID）→ `still_uncertain`（无记录/多 ID/部分量 amount≠全量均落此）；
6. 库存终态核对只查**期望端点**（房间来自 payload，非 matched）：源 H/E、目标 H 与
   基线−冻结量的关系；不吻合 → `still_uncertain`；
7. 永不返回 `observed_not_executed`（处理阶段静默丢弃路径无记录——查询不到不能证明
   未执行；无记录/窗口不全/读异常/部分量全部保留责任、不补发不重执行）。

## 3. 单条在途业务入口（工作 B）

新文件 `test/mock/treasuryTerminalTransferCoordinator.ts`（非 .test.ts，不进 Jest 收集，
不进生产 bundle）。`createSlice0TransferCoordinator({ service, host, buildContract })`：

- `requestTransfer({workKey, correlationKey})`：单条在途检查 → prepare → build →
  authorize（顺序调用，中间无外部回调）。`buildContract` 注入以便完整 reset 后换绑新模块。
- `executeTransfer(admission)`：单条在途检查（排除自身 attemptId）→ 费用前检 →
  `executeAuthorizedDispatch`。前检拒绝时**许可未消费、记录仍 pending**，恢复报价后按
  原有效期执行（N05-a 实证）。

门禁实现：每次从 `service.kernelJournal()`（持久 active 的深冻结快照）读出
`identity.actionKind === "slice0.terminal-send"` 的记录——协调器实例自身无内部可变状态
（跨实例/跨完整 reset/跨重载成立）；不使用 heap boolean、不新增持久锁、队列或第二个
活动索引。`journal.health` 为 `unhealthy/incompatible` 时 fail-closed（不把不健康视图
返回的空 active 当作没有在途工作）；`absent` 是 kernel store 惰性初始化前的**真实空态**
（首笔 admit 才建 store），放行。pending/dispatching/outcome_unknown/closing/retry_ready
全部算占用（closed 不落盘；历史 ring 不算在途）。

**入口边界**：单条在途是本原型业务入口的规则，不是通用 facade 的全局规则——N03-a 以
facade 直连对照实证（第二张许可可获得；只接纳不提交），因此验证业务的用例一律从协调器
进入；直接使用 facade 的低层隔离用例（M04、N06 的重复授权）在测试注释中注明不承担
业务门禁证明。

## 4. 冻结费用（工作 C）

- **报价只读**：`quoteTransferFee` 不再保存"最后一次报价"（`lastQuote` 全部移除）；
  报价查询不改变任何旧请求的冻结基准。
- **一次取值**：q 进入 canonical `prepared.feeQuote`，同一值派生费用 posting、durable
  payload（`f:` 字段）与执行检查；`configureFeeDrift` 只改当前报价，不回填已签发事实
  （N06 实证：drift 后 permit.postings/active worstCase/durable payload 均不变）。
- **双复验**：业务前检（协调器 executeTransfer，在 `executeAuthorizedDispatch` 之前——
  许可未消费）与 adapter guard（`execute` 内、调用 `submitTerminalSend` **之前**）共享
  `verifySlice0FeeQuote(host, args)` 纯比较：当前可信报价 ≠ 冻结 q →
  `ERR_FEE_QUOTE_DRIFTED`；报价读异常（`configureQuoteFailure`）或非法值（非安全正整数，
  如负 drift）→ `ERR_FEE_QUOTE_UNAVAILABLE`。两处拒绝均零提交（submits 计数直接断言）；
  guard 路径的许可消费后按 `nonOkOutcome="unknown"` 保守保留（不伪造 not_executed、
  不复活许可、不自行删除 unknown）。
- **submit 端口还原宿主语义**：`submitTerminalSend` 不再做费用一致性比较（引擎 API 层
  自身检查保留）——"比较已经发生在调用之后"的错误不再可能被宿主隐藏。
- 自动重试继续关闭：adapter 不提供 `retryFacts`（N06 断言 `"retryFacts" in adapter ===
  false`）；需要新费用预算走正常准备/接纳生成新工作。

## 5. T1：核验驱动可移植入口（N07）

`scripts/verify-treasury-evidence.mjs`：

- `resolveRepoRoot()` 从 `import.meta.url`→`fileURLToPath` 的脚本实际路径向上找 `.git`
  祖先目录（worktree 的 `.git` 文件同样命中）；不再依赖调用者 cwd 的 `git rev-parse`。
- 全部 Git 调用（`git show`/`git rev-parse`）显式 `cwd: REPO_ROOT`；typescript 依赖解析
  锚定 `REPO_ROOT/node_modules`。
- run-dir 相对路径按**调用者 cwd** 解析（`path.resolve(process.cwd(), args.runDir)`）并
  打印 `repo-root=`/`run-dir-resolved= (cwd=)` 行——输入含义不因脚本内部切换 Git cwd
  改变。固定 H18 expected、风险比较器与版本校验不变，不扩展成新验证平台。

## 6. N01–N08 索引

| 索引 | 位置 | 覆盖 |
| --- | --- | --- |
| N01 | `treasuryTerminalTransferSlice0RemediationI.test.ts` it「N01」（函数级矩阵） | 前缀/后缀碰撞、sender/recipient 错与缺失、from/to 错、resource/amount 破坏、旧 v1 payload、无记录/dropAll/读异常均 uncertain；正确唯一对照 committed |
| N02 | 同文件 it「N02」（函数级）+ it「N01/N02」（注册路径） | 同 ID 一致镜像去重、镜像矛盾两方向顺序无关、同视图重复描述/时点矛盾、旧记录不认领且不阻断正确记录、当前 tick 不结算、多 ID、带 order；注册 settle 入口 phase/outcome 断言 + C→D/镜像/双方错三场景 + 正确对照完成退出 |
| N03 | 同文件 it「N03」×3 | B（不同 workKey/关联键）经第二协调器被拒（理由含"单条在途"且不含窗口/额度）+ facade 直连对照；完整 reset 到开放 tick 仍拒、A 收尾退出后 B 接纳；A closing 阻断、退出并越过冷却后 B 完整闭环（恰两次提交、终态 800H/fee×2/200H） |
| N04 | `treasuryTerminalTransferSlice0.test.ts` it「M05/N04」「M07/N03/N04」×2 | 原 M05 延迟闭环与两类配对断点经业务入口重跑；当 tick未处理不释放、后续正确记录结算、cleanup 退出；closing 期间余额/容量不双扣（N03-c 终态计数）、提交恰一次 |
| N05 | RemediationI it「N05」 | (a) 前检拒→恢复报价完成 100H 闭环（实际费用=q）；(b) 再查询多次仍拒；(c) 另一准备报价+直连 facade 到 adapter guard（零提交、unknown 保留、settle uncertain）；(d) 报价读异常；(e) 非法值；(f) 独立场景 q+5 新请求闭环（实际费用=q+5）。全部"零提交"以 `host.submits.length` 直接断言 |
| N06 | RemediationI it「N06」 | durableFacts/derivePostings 重复派生恒等；permit.postings/active worstCase/持久 payload 与 canonical 同源；重复授权同一持久事实；drift 不回填；无 retryFacts |
| N07 | 主验证（verify-outside/verify-empty）+ 坏产物对照 + `controls/mutation-*` | 驱动从仓库外含空格 cwd 以绝对路径运行：正确输入 0、空/缺输入非零；篡改 trace 副本非零；三项退化敏感性变异（归属 includes 化/门禁短路/费用比较短路）各使目标用例红 |
| N08 | 主验证 + 第二上下文（evidence final/revalidation） | 固定 SHA 全量验证与第二执行上下文定向复验；生产/配置/Defense 冻结；原始日志/JSON/小型轨迹齐全；报告限定范围（原型修复/驱动 cwd/未实测引擎边界分开） |

退化敏感性（§7.2）：三项变异注入→目标 it 红→还原，原件存
`evidence/terminal-transfer-slice-0-remediation-i/controls/mutation-{1-ownership,2-gate,3-fee}.txt`。

## 7. 旧短报告勘误（历史运行结果保留身份，不抹掉）

上轮 `terminal-transfer-slice-0-local-validation.md` 及旧短报告中下列说明**不准确**，
以本文件与基线实测为准：

1. "reconcile 已核对 from/to/双方"——不准确：旧实现只以 `description.includes(k)`
   筛选候选，from/to 仅用于镜像比对与库存核对（且库存核对读的是 `matched.from/to`，
   恰是 R1-c 认领错路线的通道）；sender/recipient 不参与任何归属身份比对，
   时点只有 `Game.time > matched.time` 上界而无"不早于本请求"下界窗（order
   字段虽有类型排除，但同 ID 副本间的一致性比对不含 order/description/时点）。
2. "M07 的第二需求阻断证明单条在途"——不准确：阻断理由是 `sameWorkKeyActive`
   （同 workKey 排他），不同 workKey 的第二请求在基线实测中可获得第二张许可；单条
   在途在本轮才作为业务入口规则建立（N03）。
3. "报价在派生时点冻结、漂移即拒绝（lastQuote 机制）"——不准确：`lastQuote` 是全局
   单槽"最后一次报价"，任何后续查询都会改写比较基准（R3 实测：drift 后再查询一次，
   旧请求以陈旧预算被接受）；真正的冻结在本轮以 canonical `prepared.feeQuote` +
   双复验建立。

旧 M01–M08 运行结果保留历史身份（其所验证的延迟闭环/负向保守/断点恢复行为在本轮
M 用例改造后继续全部成立——16/16）；上轮报告不因此改写。

## 8. 边界与不做

- 不修改生产 kernel/facade/actionContracts/coverage/observation/生产 testHarness/生产
  装配/配置/lockfile；不部署、不上传、不启动真实服务器、不调用任何真实经济 writer。
- 不新增生产持久字段/schema 版本/永久 store/报价注册表/第二许可发行器/持久锁；不
  追加多房间调度、通用部分结算、真实引擎设施；后续隔离引擎实验仍按上轮 §3 只准备
  不执行。
- 100 H 是测试夹具值；C/D 房间仅作错路线反例噪声（N01/N02 注册路径），不开放新业务路线。
