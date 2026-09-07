# Empire Treasury — Terminal Transfer Slice 0 · Remediation I
## 完整交易归属、单条在途与冻结费用校验

**用途：开发 Agent 直接实施、测试、commit、push。本文自包含，不需要读取聊天历史。**

编制日期：2026-09-07。状态：**待执行任务书，不是验收通过报告，不是部署许可。**

任务身份：**Terminal Transfer Slice 0 · Remediation I**；验收索引 **N01–N08**。承接 Slice 0 的 M01–M08。不要执行旧的内核 Remediation I，不启动 Slice 1、Core Rewrite V 或另一轮证据平台建设。

> 本轮只修测试专用调拨原型的三项既有契约：正确识别本请求的交易、真正限制一条在途、把执行费用绑定到该请求已授权的冻结费用。顺手修核验驱动的 cwd 定位。正常延迟完成、部分量保留责任和配对恢复继续保留；生产内核不解冻。

## 1. 起点与继承状态

| 项目 | 编制时核对值 |
| --- | --- |
| Repository | `ceyirelehe47/screeps-bot` |
| Branch | `refactor/empire-treasury-rearchitecture` |
| 本轮预期起点／上轮交付 HEAD | `93a6152507167478a4cb005168e47d639b924436` |
| 上轮最终代码／测试验证 HEAD | `0ce9d971bcf72daf19a1fe68fd7bb384e4db56fe` |
| 上轮实现提交／预算锚点 | `44aae6142b6dad80a53511448bbccb5c242a1940` |
| 持续生产冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 当前预算与上轮提交结果 | 237 suites／1428 tests／1428 passed；failed、pending、todo、runtime error 为 0 |
| 上轮定向结果 | Slice 0：1／8；KEY：6／65；Treasury：33／582；Defense：11／118；集合重叠，不累加 |
| OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |
| 当前内核 | `Memory.runtime.treasuryCore`；schema v3；attempt `tk1_` |

测试数字是 Agent 提交的运行证据，不是本文编写方独立重跑全仓的结果。编制时 GitHub HEAD 仍为上述起点。[R1–R3] 实施时先 fetch；远端前移则核对增量并沿最新历史继续，不退回旧 SHA，不覆盖未提交工作。

**继承结论：**此前内核限定通过继续保留；Slice 0 正常离线调拨和延迟结算已存在，部分 60/100 的结果没有被判全额完成；但本轮审查不接受原报告的“M01–M08 全通过、无适配问题”。已知缺口见 §3，修正的是原型，不是通用内核。

硬限制继续保持：active 64、recent ring 128、核心 JSON 字符预算 360,000、生命周期 8 份/tick、消费者释放成对预扣 2 份且至多 4 次/tick、每记录至多 8 个消费者及 12 条 worstCase 腿、现有 fresh 限额。不得以扩容或放宽校验解决本轮问题。

## 2. 实施边界

主要允许修改：

- `test/mock/treasuryTerminalTransferPrototype.ts`，必要时拆出一个很小的测试专用业务协调模块。
- `src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts`；建议新增 `treasuryTerminalTransferSlice0RemediationI.test.ts` 承载 N 反例。索引是验收分组，不要求恰好八条测试。
- `scripts/verify-treasury-evidence.mjs` 的仓库定位、必要 cwd 参数及对应自测；预算 manifest 与现有预算脚本的锚点元数据；本轮文档和原始证据。

**禁止修改生产 kernel、facade、actionContracts、coverage、observation、生产 testHarness、生产装配、配置、依赖及 lockfile；禁止修改 Defense 生产行为。**不要把生产逻辑搬到测试豁免目录以伪造冻结。现有通用恢复 harness 和 Seal 风险检查器默认不改，不新增另一套回放器或证据协议。

禁止部署、上传游戏代码、启动真实游戏服务器、运行 `npm run push`／`npm run local`，以及调用真实 `terminal.send()`、`Game.market.deal()` 或其他经济 writer。不得使用正式账号、PTR、现有私服、玩家 Memory 或凭证。默认 Jest、自测和核验入口均离线。

业务范围不扩大：同一合成用户、同一 shard、指定源 `W1N57` 与目标 `W10N57`，只调拨 **100 H**，无 Power、无市场/搬运/生产并发、不自动重试。100 是测试夹具值，不是正式服额度。C/D 房间可以作为错路线反例的噪声，但不因此开放新业务路线。

内部类型和编码由实施者选择。允许补足**测试原型自己的 canonical 参数和已有有界 durable payload**，但不新增生产持久字段、schema 版本、永久 store、报价注册表、第二套许可发行器或持久锁。既有 payload 上限与字符约束不变；确有接口缺口则按 §8 记录 ADAPTER_GAP，而不是自行解冻内核。

## 3. 已确认的问题与基线复现

### R1：候选交易反过来决定了“期望身份”

起点 `reconcile()` 使用 `description.includes(payload.k)`，没有将源/目标和交易双方与当前请求的期望值核对；库存检查使用 `matched.from`／`matched.to`；同交易 ID 的冲突比较不含完整描述、双方和时间。[R4]

已有独立 Node 探针运行了移录的函数片段，观察到下列输入返回 `observed_committed`：完整关联键错误但包含期望键；交易双方错误；请求 A→B 却读取 C→D 的记录且 C/D 数值吻合；同 ID 镜像描述矛盾。正确全量、无记录、部分量有合法对照。这些是**函数级结果，不是原仓库集成测试**。

### R2：只防同 workKey，没有限制单条在途

现有测试直接构建 contract 并调用 facade；kernel 的 `sameWorkKeyActive` 只防相同 workKey。当前 M07 的第二需求仍使用相同 workKey，不能证明不同请求也被阻断。[R5]

基线反例：A 以 `biz:slice0:req-A` 接纳并提交、保持 unknown；B 使用不同的 `biz:slice0:req-B` 和不同关联键、相同合法路线，剩余资源/容量充足。要求 B 在新增接纳/提交前阻断；基线调用链预期仍可接纳。这项此前是**静态推演，必须在原仓库实跑确认**。

### R3：最近一次报价可替换旧请求的比较对象

`quoteTransferFee()` 改写 `state.lastQuote`；submit 比较 currentCost 与这个可变 lastQuote，而不是许可已经绑定的 fee。独立片段探针观察到：原冻结 fee=26，漂移到31，再正常查询一次报价，lastQuote=31，旧请求被接受。未再查询的分支虽报错，但也已经进入 submit 一次。[R4]

数字26/31是既有固定场景的复现值；仓库测试应从正常报价取得 q，再使用 q+5，不把具体费用硬编码成规则。漂移是已有假端口能力，不宣称真实无 Power 固定路线会自行涨价。

### T1：核验驱动仍依赖调用者 cwd

驱动通过无 cwd 的 `git rev-parse`／`git show` 定位仓库。仓库外以绝对路径运行时可能失败或选中另一个仓库。[R6] 本轮只修定位，不重写其核验逻辑。

**先保存基线，再修复：**在起点的隔离 worktree，使用真实原型/contract/facade/许可/Memory 路径编写最小回归。附带的 `treasury-terminal-slice0-review-probes.zip` 可帮助理解，但不是必需输入，也不能代替仓库反例。探针中的断言检查的是旧行为，不可直接当作修复后通过标准。

基线应记录具体结论、phase、提交次数、pending 数、费用腿和拒绝位置。错误交易反例必须让其他成功条件成立，避免因库存不符或时间尚早而偶然安全；同一轮有正确交易对照。若某条仓库反例不成立，如实给调用轨迹和原因，不改坏代码凑红，不仅引用旧 ACCEPT。

## 4. 工作 A：用请求事实核对交易归属

### 4.1 期望值先存在，再读取候选记录

reconciler 的期望路线、资源、数量、完整关联描述、合成用户身份、请求时间关系及必要结构身份，来自**已授权请求的有界持久事实、已有 postings 和可信场景配置/适用观察**。不能从 `matched.from/to/sender/recipient` 生成期望值，也不能依赖 reset 前的局部 Map 或“最后一笔请求”闭包。

推荐流程是测试协调层先从可信报价与场景事实准备一次不可变请求，再调用原 contract 构建/接纳；派生函数只从这份固定输入取值。当前 facade 的 `buildIdentityFacts()` 会再次调用 adapter.durableFacts，因此必须检查重复派生不会重新抓取不同的余额、报价或时间，导致 digest、postings 和持久事实各代表不同准备时刻。[R7] **在原型中保证派生一致，不借此修改 facade。**

准备与执行保持原同 tick 许可规则；跨 tick 的准备不能被当成当前新授权。需要恢复的事实写入已有 bounded payload；编码版本、长度、字符集以及新旧 payload 无法解释时的保守行为必须明确。不要求迁移历史测试原型记录；不支持的旧 payload 留在 unknown，不猜测补齐身份。

### 4.2 精确匹配与同 ID 去重

完整 description 使用确定编码并严格相等，不用 includes、startsWith、模糊正则或只比较短键。安全 ASCII 范围保持；关联键只标识隔离 run/request，不是签名，也不是新的生产永久唯一性方案。

核对顺序必须确保：

- 实际记录对应期望的源、目标、资源、全量100及发送方/接收方；市场订单记录不作 send 成功证据；库存只检查**期望端点**。
- 交易时点不早于本请求合法提交范围，不晚于当前可见时点；使用的源/目标观察已经覆盖效果可见时点。只有 `Game.time > record.time` 不能排除本请求之前的旧记录。当前 tick 未处理时，单纯刷新观察不得结算。
- 同一交易 ID 在同视图或两视图重复出现，内容一致可归并为一条；相关 ID 的描述、双方、时间、路线、资源、金额和 send/order 属性有矛盾，整体保守阻断，不能 first-record-wins。先确认同 ID 内容一致，再选择唯一事实，避免把矛盾镜像先过滤掉。
- 多个不同交易 ID 都可能属于同一请求时，不任选一个成功记录。无记录、视图异常、历史不可用、只有库存变化、部分60/100仍保留责任，不自动补发、不报告 not_executed。

不必新建跨视图证明链。继续使用当前明确的视图策略；只有一个可用视图的支持边界如实说明，缺失不能假设一致。与请求无关的合法噪声不应一概阻断正确唯一记录。

### 4.3 反例不能靠错误的旁支条件通过

至少覆盖以下“只破坏一项归属”的对照：

1. 完整关联键的前缀/后缀碰撞；库存和时间已满足正常成功条件。
2. sender 错、recipient 错、必要身份缺失；其余正确。
3. 请求 A→B，记录 C→D，A/B 不变而 C/D 数值恰好符合原数字基线；期望仍是 unknown。另以 A/B 正常终态配错路线记录，隔离路线判断。
4. 同 ID 的 incoming/outgoing 或同视图重复记录仅描述/双方/时间矛盾，检查顺序交换也拒绝；一致副本可通过。
5. 本请求之前的旧记录不能被当前相似库存认领；正确时间与完整归属的唯一记录恢复正常完成。

归属逻辑先用公开形态独立夹具定向验证，再通过 `service.settleUnknownOutcome({attemptId})` 验证真实注册路径与持久 phase。禁止测试直接改成 closing/committed。假宿主私有 pending、submits、期望答案只给测试断言，不给 reconciler。

## 5. 工作 B：测试专用业务入口维持单条在途

建立一个很小的原型业务协调入口，统一“准备/接纳/执行”。它复用 facade，不复制通用授权引擎、不改 kernel 的多 workKey 语义。

接纳前读取 `service.kernelJournal()` 等现有只读视图。健康性不可确认时 fail-closed；不能把不健康视图返回的空 active 当作没有在途工作。只要当前 active 中仍有本原型动作的未结束记录，就拒绝另一笔请求，**不以 workKey 相同为前提**。pending、dispatching、unknown、closing 和仍未安全关闭的 retry_ready 都算占用；历史 ring 不算在途。

检查与原接纳顺序调用，中间不插入外部回调；接纳成功后的 active 记录本身维持限制。不要使用 heap boolean 代替持久事实，不新增持久锁、队列或第二个活动索引。两个协调器实例必须读取同一 active；第二个请求可有不同 key，但不能得到第二张许可或第二次 submit。

**明确入口边界：**单条在途是这个原型业务入口的规则，不是通用 facade 天然具备的全局规则。所有声称验证该业务的正向/集成用例都从该入口进入；仅用于隔离已有低层行为的测试可直接使用 facade，并注明不承担业务门禁证明。不得对通用 API 作其没有实现的保证。

完整 JSON 重载并重建模块/registry/协调器后，B 仍被 A 的 active 事实阻断；不得用同 tick 已关窗、旧许可过期、额度不足或 registry 未装配代替在途门禁。测试必须到下一合法开放 tick，确认 B 的其他条件成立、拒绝理由指向在途责任。

A 正常结算但仍 closing 时继续阻断；A 经原 cleanup 真正退出后，新 B 可以正常接纳并按场景在冷却允许时执行。unknown/部分结果不能被协调器 TTL 删除来腾位。若某请求明确仍为 pending，可经既有安全取消退出；不能取消已经可能提交的 unknown。

独立反例可以各自建立全新合成场景；验证同一条在途责任跨实例/跨reset保持的用例，必须保留那条active记录和配对宿主状态，不能通过重新调用makeScene、清空Memory或提前清理来让第二请求成功。

## 6. 工作 C：冻结本请求费用，调用提交端口前复验

### 6.1 报价只读，本次预算不可被查询覆盖

移除 lastQuote 作为授权比较权威的用途。报价查询不得改写任何旧请求的冻结基准。准备层从显式可信假报价端口读取一次 q，形成该请求的不可变数据；对外业务调用者不能自行填写一个更低费用获得预算。

推荐让 q 进入内部 canonical 请求，由同一值派生费用 posting、durable payload 和执行检查；准备余额、时间等同理一次取值。具体内部字段/编码不在任务书固定。不得新增按 attempt 永久保存报价的 Map/store，也不能在执行时把最新报价回填成“当初授权的报价”。

证明：contract 的费用腿、dispatch permit 的费用腿、active 中 worstCase 的费用责任、durable payload 及执行所比较的 q 相同。仅再次调用报价、重复派生或准备另一个未接纳请求，不得改变已经签发请求的事实。

### 6.2 冻结值与当前报价不一致时，submit 调用次数必须为零

在业务执行入口以当前可信报价比较 q；并让注册 adapter 的 `execute(canonicalArgs)` 在实际 `host.submitTerminalSend()` **之前**再次使用相同判定，避免测试只在外层帮忙挡住、adapter 本身仍可提交旧预算。两处复用一个小型纯比较逻辑，不建立第二个授权体系。

本限定场景对任何报价不一致均拒绝旧请求；报价读异常/非法值同样不提交。比较基准只能来自这张真许可绑定的 canonical 数据，不来自 current quote、最后一次查询或另一请求。submit 端口保留宿主接受语义，不能再替 adapter 隐藏“比较已经发生在调用之后”的错误。

**区分拒绝时点，不制造新的内核语义：**

- 业务前置检查在调用 `executeAuthorizedDispatch` 之前拒绝，可以保持许可未消费、记录仍 pending；恢复原条件后按原有效期执行，或经既有安全取消，再准备新请求。
- 如果用直接 facade 调用隔离 adapter guard，kernel 可能已经消费许可并发布调用边界；adapter 返回失败且 `nonOkOutcome="unknown"` 时，记录按原协议保守保留即可。要求的是 submit=0，不要求伪造 not_executed、不要求把许可复活，也不自行删除 unknown。

自动重试仍关闭，不实现 retryFacts。需要新费用预算时，通过正常准备/接纳生成新工作，不偷偷修改旧 permit/active/postings，不自动补发。

### 6.3 必跑费用序列

先正常 prepare→build→admit，保存真许可与 q；然后分别验证：报价涨到q+5但不再查询；涨到q+5又查询一次或多次；另一个未执行准备过程进行报价；报价读取异常。每种场景的旧请求都不能进入 submit，原费用腿保持 q。至少一条走业务入口，至少一条绕过业务前检、直接提交**真许可给 facade**以到达 adapter guard。

恢复原报价的未消费请求或在独立合法场景重新准备q+5的新请求，必须能够完成100H延迟闭环，实际费用与新授权相同。不能“所有报价相关请求一律拒绝”通过。

价格不变但货物不足、运费能源不足、目标空间不足、结构替换的旧 M04 对照保留，所有声称“零提交”的断言都直接检查 `host.submits.length` 增量为0，不能只检查 pending=0 或 outcome不是committed。

## 7. 小修 T1、验收索引与停止条件

### 7.1 核验驱动只修可移植入口

通过 `import.meta.url`／`fileURLToPath` 得到实际脚本路径，再定位其所属仓库；所有 Git 调用明确指定该 repo 的 cwd，依赖解析也锚定它。run-dir 的相对路径按调用者 cwd 解析并记录，不能因为切换 Git cwd 改变输入含义。

用含空格的仓库外临时目录作为 cwd，以脚本绝对路径和输入绝对路径运行：正常产物返回0，空/缺输入及坏产物返回非零。不得要求使用者先 cd 到目标仓库。既有固定 H18 expected、风险比较器和版本校验保留，不扩展成新验证平台。

M03 的“默认无注册”检查不再先清空待检查注册表再宣布不存在；用隔离新模块的真实默认装配断言。以上以及 M04 的提交计数补断言均在固定验证前完成，不留到证据归档提交后再改测试。

### 7.2 N01–N08

| 索引 | 必须证实的内容 |
| --- | --- |
| N01 | 从实际请求事实核对完整描述、预期路线与双方；错归属不能靠候选记录反推期望端点；成功条件齐全的最小错误对照仍拒绝，正确唯一记录完成 |
| N02 | 同 ID 全部相关副本冲突拒绝且顺序无关，一致去重合法；旧记录/未覆盖观察/无记录/异常/多ID/部分量保守；至少有通过注册 settle 入口的 phase 断言 |
| N03 | 不同 workKey、不同关联键的B在A未结束时拒绝；跨协调器与完整reset到开放tick仍拒绝，理由是单条在途；A仍closing阻断，退出后B正常开放 |
| N04 | 原 M05/M07 的延迟成功与两种配对断点经新业务入口实际重跑；当tick未处理不释放，后续正确记录结算、cleanup退出；在记录仍closing时检查可信余额/容量不双扣，最后提交恰一次 |
| N05 | q→q+5、不重新查/重新查/其他准备报价/读取异常均不使旧请求进入submit；业务前检与adapter guard各自真实覆盖，旧责任不变，正常新报价有完成对照 |
| N06 | canonical、postings、permit、active/durable的费用与身份同源且重复派生稳定；M04各拒绝明确submit=0；原型无自动retry、不新增持久权威、不进入生产装配 |
| N07 | 驱动从仓库外含空格cwd运行，正确输入0、错误输入非零；固定helper/expected和旧合法对照保留；代码和自测先提交后运行 |
| N08 | 固定SHA主验证＋第二干净上下文定向复验、生产/配置/Defense冻结、原始日志/JSON/小型调用轨迹齐全；报告限定范围，不宣称真实引擎已跑通 |

不为索引凑测试数量，不删旧测试、不加skip/only。新增目标测试必须至少对对应退化敏感：错误归属检查缺失、业务门禁绕过、费用 guard 跳过各做一个小型负向变体，目标用例应因行为断言失败；无关合法对照仍绿。不要变成全仓变异测试项目。

**本轮退出点就是上述三项适配缺口和T1完成。**不追加多房间调度、生产报价发行器、通用部分结算、永久审计存储或真实引擎设施。发现额外问题按“本轮直接阻断／后续待验证”分别记录，不借低优先级报告问题继续扩大架构。

## 8. 执行顺序、产物与不确定性处理

1. 读取本文件全文，核对标题、N01–N08、工作树与远端HEAD；按 §3 保存原仓库基线反例和合法对照。
2. 在测试侧完成A/B/C和T1，更新M用例与来源/差异说明。优先减少错误入口，避免再加平级权威。协议语义如有变化，为测试adapter正确更新版本/semanticIdentity并重建新场景；不把旧payload静默升级。
3. 开发树定向绿后提交所有执行性变更、测试、自测和验证驱动；预算按实际收集更新，再固定 `VALIDATION_HEAD`。预算锚点、验证HEAD、最终交付HEAD分别记录。
4. 在固定SHA的干净工作树完成 §9 主验证；独立 reviewer 在同SHA第二干净worktree读本任务全文，复跑 N/M＋KEY＋Defense和cwd自测。没有独立reviewer就如实写同执行者复现，不冒称独立审计。
5. 验证后仅追加日志/数据/文档。用于核验、篡改夹具、决定pass/fail的可运行脚本均须在固定提交中；不要再以“位于evidence、不是Jest对象”解释后置执行代码。命令实录 `.command.txt`、退出码与日志可以后置归档。
6. Git commit/push当前分支，核对远端HEAD；不reset已推送历史、不rebase、不force push、不amend已推送提交、不合并main。

本轮证据根：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-slice-0-remediation-i/`

保留简明的 `task/`、`baseline/`、`controls/`、`final/`、`revalidation/` 与主报告。基线临时测试原件如不属于正常收集，归档为 `.ts.txt` 并记录还原命令。不要重复搬运整套历史证据或每个小场景生成1MB轨迹。

小型轨迹应直接说明：场景/request/workKey/attempt；期望和读到的交易归属；各阶段phase；费用q/current/实际；submit前后计数；拒绝理由；reset点与最终active是否退出。不要只交测试标题或主观ACCEPT。

主报告 `terminal-transfer-slice-0-remediation-i-local-validation.md` 逐项列N结论，并修正旧短报告中“已核对from/to/双方、仅同workKey就等于单条在途、lastQuote冻结费用”的不准确说明；旧运行结果保留历史身份，不抹掉旧失败。

若已有接口不足以在本范围表达必要事实，先给最小可运行反例、调用链和合法对照，标记 **ADAPTER_GAP** 并继续完成无关部分。不静默修改生产内核，不用skip造全绿。实跑未完成、环境失败和行为失败分开，不能仅凭独立片段探针声称仓库验证完成。

## 9. 固定提交验证模板

以下新测试路径为建议，若实施者选择其他文件名，必须在固定验证前替换为实际存在路径，记录完整命令。所有输出写仓库外；禁止上线命令。新增默认测试不联网。

```bash
set -euo pipefail
unset DEST
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
START_HEAD=93a6152507167478a4cb005168e47d639b924436
VALIDATION_HEAD="$(git rev-parse HEAD)"
OUT="$(mktemp -d)"
printf '%s\n' "$VALIDATION_HEAD" > "$OUT/validation-head.txt"
printf '%s\n' "$START_HEAD" > "$OUT/expected-start.txt"
git status --porcelain > "$OUT/status-before.txt"
test ! -s "$OUT/status-before.txt"
node --version > "$OUT/node-version.txt"
npm --version > "$OUT/npm-version.txt"

run() {
  local name="$1" rc; shift
  printf '%q ' "$@" > "$OUT/$name.command.txt"
  printf '\n' >> "$OUT/$name.command.txt"
  if "$@" > "$OUT/$name.log" 2>&1; then rc=0; else rc=$?; fi
  cat "$OUT/$name.log"
  printf '%s\n' "$rc" > "$OUT/$name.exit-code.txt"
  return "$rc"
}

run production-freeze git diff --exit-code "$FREEZE_BASE" "$VALIDATION_HEAD" -- \
  src ':(glob,exclude)src/**/*.test.ts' ':(glob,exclude)src/**/*.spec.ts'
run config-freeze git diff --exit-code "$FREEZE_BASE" "$VALIDATION_HEAD" -- \
  package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs
run defense-freeze git diff --exit-code "$FREEZE_BASE" "$VALIDATION_HEAD" -- \
  src/runtime/defenseFocusFire.ts src/runtime/engagementFallbackRevision.ts \
  src/runtime/defenderRampartAllocation.ts src/runtime/homeDefense.ts \
  src/runtime/towerControl.ts src/runtime/physicalRampartOwnership.ts src/roles/homeDefender.ts
git diff --name-status --no-renames "$START_HEAD" "$VALIDATION_HEAD" > "$OUT/changes-this-round.txt"
git diff --name-status --no-renames "$FREEZE_BASE" "$VALIDATION_HEAD" > "$OUT/changes-from-freeze.txt"

run typecheck npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run build npm run build
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/bundle-sha256.txt"

NM_FILES=(
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts
)
for file in "${NM_FILES[@]}"; do test -f "$file"; done
run jest-slice0 npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${NM_FILES[@]}" --json --outputFile="$OUT/jest-slice0.json"

KEY_FILES=(
  "${NM_FILES[@]}"
  src/runtime/treasury/treasuryRemediationIVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVIKernel.test.ts
  src/runtime/treasury/treasuryRemediationIVService.test.ts
  src/runtime/treasury/treasuryRemediationVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVService.test.ts
)
for file in "${KEY_FILES[@]}"; do test -f "$file"; done
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-key"
run jest-key npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${KEY_FILES[@]}" --json --outputFile="$OUT/jest-key.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-treasury"
run jest-treasury npx jest --config jest.config.cjs src/runtime/treasury/ \
  --runInBand --json --outputFile="$OUT/jest-treasury.json"

DEFENSE_FILES=(
  src/runtime/defenseFocusFire.test.ts
  src/runtime/defenseFocusFireStateful.test.ts
  src/runtime/defenseFallbackReallocation.test.ts
  src/runtime/defenseAllActorReservation.test.ts
  src/runtime/defenseGlobalRampartFootprints.test.ts
  src/runtime/defensePreallocationRampartOwnership.test.ts
  src/runtime/defenseStationaryRampartOwnership.test.ts
  src/runtime/homeDefense.test.ts
  src/runtime/towerControl.test.ts
  src/roles/homeDefender.test.ts
  test/memoryDeclarationBoundaries.test.ts
)
for file in "${DEFENSE_FILES[@]}"; do test -f "$file"; done
run jest-defense npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${DEFENSE_FILES[@]}" --json --outputFile="$OUT/jest-defense.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-full"
run jest-full npx jest --config jest.config.cjs --runInBand \
  --json --outputFile="$OUT/jest-full.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-budget"
run budget node scripts/verify-jest-budget.mjs
run verify-evidence node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
  --validation-head "$VALIDATION_HEAD" --run-dir "$OUT" --fixture h18

# T1：同一个已提交驱动，从仓库外含空格目录运行。
FOREIGN_CWD="$OUT/foreign cwd"
mkdir -p "$FOREIGN_CWD" "$OUT/empty-input"
(
  cd "$FOREIGN_CWD"
  run verify-outside node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
    --validation-head "$VALIDATION_HEAD" --run-dir "$OUT" --fixture h18
  if run verify-empty node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
    --validation-head "$VALIDATION_HEAD" --run-dir "$OUT/empty-input" --fixture h18; then
    echo 'ERROR: 空输入意外通过' >&2
    exit 1
  fi
)
test "$(cat "$OUT/verify-empty.exit-code.txt")" -ne 0
# N07 的坏产物对照和三项目标退化，运行已提交的定向自测/原件并单独保存。
# 它们若不在上述Jest集合中，必须在commands.txt列出实际命令并执行，不能省略。

run diff-check git diff --check
printf '%s\n' "$(git rev-parse HEAD)" > "$OUT/head-after.txt"
test "$(git rev-parse HEAD)" = "$VALIDATION_HEAD"
git status --porcelain > "$OUT/status-after.txt"
test ! -s "$OUT/status-after.txt"
printf '产物目录：%s\n' "$OUT"
```

预算按真实收集滚动，不硬凑1428。budget自带的全仓重跑单列，不覆盖主Jest JSON。KEY/M/N/Treasury集合重叠，不相加。构建包含时间/Git身份时，bundle hash只作产物追溯，生产冻结以diff为准。

第二上下文使用同一固定SHA、独立依赖安装/缓存/输出，复跑NM、KEY、Defense及cwd正负对照；保存自己的命令、退出码、Jest JSON和小型业务轨迹。没有新变更时不必在第二树再跑一次全仓压力。原始失败与重跑分开，核验输入根按 `OUT/trace-key` 加 `OUT/jest-key.json` 布局，不再把trace子目录本身当run-dir。

最终归档前后核对 `git diff --check`、`git status --short`、`git log --oneline --decorate -40`。后置任何执行性改动都重新固定相应验证。push当前分支并核对远端，查询status/checks/Actions；空结果如实标无CI证据。

## 10. 完成定义

满足N01–N08，且至少有一条真实走过准备→接纳→真许可执行→假宿主延迟处理→注册对账→原cleanup退出的100H正向链路；三类错误分别在正确边界被挡住；旧责任不被伪造清除；生产/配置/Defense冻结。

最终结论分开写：**原型限定修复、旧核验驱动cwd、生产冻结、未实测引擎边界**。本轮通过只允许结束这份离线补修，不自动授权启动服务器、上传脚本或真实转运。

---

## 附录：审查与定位依据

项目源码均锁定 `93a6152507167478a4cb005168e47d639b924436`，实施时按实际行号核对：

- [R1] 分支最新commit：编制时通过GitHub connector读取，仍为93a6152。
- [R2] `test/test-suite-budget.json`：237／1428，锚点44aae614…。
- [R3] `openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-slice-0/final/validation-head.txt`：0ce9d971…；同轮主报告及原始Jest结果区分Agent侧运行与审查方复现。
- [R4] `test/mock/treasuryTerminalTransferPrototype.ts`：`reconcile`、`quoteTransferFee`、`submitTerminalSend`、`durableFacts`、`captureBranch`。起点blob `7de6872ec9c6e521afaaea4d824e333b0cf24189`。
- [R5] `src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts`：admit、M04、M06、M07；`kernel/commands.ts` 的 sameWorkKeyActive：通用规则仅同workKey排他。
- [R6] `scripts/verify-treasury-evidence.mjs`：`loadVerifierFromCommit`与Git调用定位；保持既有固定H18约束和helper复用。
- [R7] `src/runtime/treasury/facade.ts`：buildIdentityFacts再次调用durableFacts；coreAdapterPort仅将canonical args交给execute；reconcileOutcome将已有durable facts/postings与service.observation交给注册reconciler。只读定位，不授权修改。
- 原任务书：`treasury-terminal-transfer-slice-0-implementation.md`，M01–M08。其交易身份、单条在途与费用要求由本任务落实，不增加新业务种类。
- 可选审查附件：`treasury-terminal-slice0-review-probes.zip`，README明确只包含函数级移录复现，不是完整仓库测试；本任务已给出其核心反例，缺该附件也应直接实施。
- 原型已采用的固定engine基准 `80977824199a596d174d392fd0cf8c458c21fcbd`，driver `cf63d8adf902663e2ebddd7f8c5b7baa425dc928`。沿用已归档来源，不重新研究其他writer；源码契约、假宿主行为和真实实验结论始终分开。
