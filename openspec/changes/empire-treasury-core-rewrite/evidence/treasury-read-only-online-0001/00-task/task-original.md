# Treasury Read-only Observation I — 线上基线核对与限定采样 0001

日期：2026-09-10  
交付类型：**执行任务书，不是新实现包。**  
任务顺序：**先取得实际线上事实 → 判定部署差异 → 仅在范围与授权均满足时启用只读观察 → 有界采样 → 关闭并核对。**

## 0. 给执行 Agent 的摘要

你接手的是已经入仓且经过离线验收的只读观察器，不需要重新应用旧补丁，也不需要重新实现 Treasury。首先查明实际线上运行的代码、账号/服务器/shard/活动代码分支和相关状态；不能先上传重构分支再证明它适合上线。

本任务有两个合法完成出口：

- **线上基础不一致、身份无法确认或部署授权不覆盖：** 完成可执行的差异报告，停在未部署状态。这不是需要不断重试的失败。
- **线上基础可证一致、差异仅为已验收观察功能和限定配置、部署及关闭已获授权：** 使用正常 bot 主程序做一次小范围只读采样，取得原始证据并关闭。不得开放新的资源调拨或市场动作。

“新增观察器只读”不等于“整份 bot 只读”。原有生产、物流、市场、Defense、Treasury 生命周期和旧监控保持原行为；本轮不为采样制造交易，不清空或修复线上 Memory，不把任何诊断数字用作执行许可。

---

## 1. 固定基线、继承成果与未知项

### 1.1 仓库身份

| 项目 | 内容 |
| --- | --- |
| 仓库 | `ceyirelehe47/screeps-bot` |
| 工作分支 | `refactor/empire-treasury-rearchitecture` |
| 预期任务起点 | `828a078473c97562219d9cb5abfdd6df2ef5c79b` |
| 上轮代码/测试/预算验收基线 | `37e33904dd95d9723233cfb959102c02cd61591f` |
| 当前预算引用的代码锚点 | `5c8a9d3ae2414bff7db7684f7d84ff6aaad5638c` |
| 上轮完整回归 | 248 suites / 1539 tests；原始结果失败、pending、todo、运行错误为零 |
| 当前功能结论 | `READ_ONLY_CODE_VERIFIED / NOT_DEPLOYED` |

任务编写时重新读取了远端 HEAD，仍为上述 `828a078…`。[S1]

全仓结果属于上轮实际执行环境；本轮若复用，明确写“继承”，不得标为当前新配置或当前线上版本的全量通过。上轮验证与证据 HEAD 的运行源码、测试、预算和依赖身份已经核对；本轮开工仍应确认未发生新改动。[S2]

### 1.2 不再重做的内容

首条国库本地实机闭环已在 `cf29a69477a7c2ddd863efb800e9e8735e9b3cce` / `lab-ti1-0002` 取得限定通过：T536 接纳并调用100H，T537注册结算，T538工作退出。该实验保持关闭；不再创建 standalone 世界、不调用 `run-formal` / `run-treasury`，不重复100H正常路径。

只读观察器已经完成原样实现、真实 facade 读取测试、独立反例和全仓回归。本轮不重新应用任何旧 ZIP/patch，不回到 `bd9570d…` 的源ID/shard/费用修补阶段。随附旧检查点只是历史资料，其“尚无转运证据”等内容不代表当前状态。

### 1.3 当前尚未取得的事实

尚未核对实际正式账号的活动代码与本分支差异；尚未选定实际线上服务器、shard、代码分支和房间；尚未测量只读观察器的线上 CPU 成本、数据覆盖与兼容性。**不得把本地实验的 `Forst`、合成用户名、Terminal ID、T536或固定路线复制成线上配置。**

---

## 2. 授权与执行边界

这份任务书不代替用户对真实账号连接、代码上传或回退的授权。按执行会话中实际指令判定范围：

1. 仓库读取、本地分析/测试/构建、任务证据归档及按原工作流向上述 GitHub 分支提交，不涉及游戏部署。
2. 线上只读查询须有覆盖目标账号/服务器的授权；已有明确授权不逐命令重复确认。没有时，只处理一次范围确认，同时继续不依赖线上连接的本地准备。
3. **上传/覆盖代码、切换活动代码分支、恢复旧模块均是线上写操作**，不包含在单纯“允许读取线上状态”中。启用前必须确认授权覆盖本次限定配置、真实受影响范围、采样上限，以及关闭/故障回退。已有一次完整的条件式授权时，不再重复确认同一范围。
4. 未覆盖部署时，交付阶段A的基线与差异报告，标为未部署，不用“任务要完成”作为扩权理由。

禁止市场成交/订单改动、Terminal试发、资源往返归还、任务创建/取消、清空国库、重置 unknown、世界序推进、临时激活旧LAB入口、修改Defense或全局暂停 bot。原 bot 自己按原有代码发生的正常动作不是本轮新授权动作；不得为了让库存保持静止而停掉原经济系统。

普通 HTTP 读取与“向玩家 console 投递一段表达式”不是同一操作：后者仍是向线上注入待执行代码。优先使用已有只读API与原有监控。确需只读表达式时，先审阅表达式并确认授权覆盖；仅访问限定字段，不调用 `ensure*`、生命周期、注册服务、claim同步或清理函数，不通过构造 Treasury 服务“帮助初始化”。

凭据由执行环境已有的安全配置提供。不把 token 放在命令行、报告、截图、Git提交或完整环境转储中；不打印 `.secret.json` / `.env`。缺少凭据时通过环境既有配置方式解决，不要求用户在聊天中粘贴 secret。

---

## 3. 修改白名单与责任分工

本轮允许的改动：

| 范围 | 允许内容 |
| --- | --- |
| `src/config/treasuryReadOnly.ts` | 仅在阶段A通过且获得部署授权后，绑定本轮明确的采样profile；收尾恢复默认关闭 |
| 本轮证据目录 | 原始响应、模块摘要、差异、配置、命令与退出码、采样、分析、关闭结果；敏感原件留在受控本地副本 |
| `docs/treasury-read-only-observation.md`、当前 OpenSpec 状态文档 | 追加实际结果与限制，不覆盖历史失败原件 |
| 仓库外的操作辅助脚本 | 限定的只读收集、离线解析、部署/恢复调用的薄包装；可审阅、可终止、无额外账号或自动扩权 |
| 针对本轮profile的测试 | 必要的小型配置验收，不修改既有默认关闭测试来迎合启用配置 |

生产 `src/main.ts` 挂载、观察器实现、facade/kernel/observation/commitments/runtimeServices、原shadow、经济writer、Defense、Memory类型、根依赖、rollup和部署守卫保持不变。不开新的只读服务，不复制库存/预留账本，不增加持续采样队列、持久开关或线上命令。

发现功能性缺陷时：保留最小失败输入、原始输出和代码位置，交回实现方处理。Agent负责此次环境核对与验收，不自由重写观察器或迁移整个国库。现有能力不支持某项线上操作时，先明确缺口；不能把临时薄包装扩大成新的部署平台。

---

## 4. 阶段A：取得实际线上基线，不改变游戏状态

### A1. 本地与远端起点核对

在干净工作树记录以下输出，命令日志写到仓库外的新目录，避免把证据本身变成部署时的脏树：

```sh
git status --short
git branch --show-current
git rev-parse HEAD
git fetch origin refactor/empire-treasury-rearchitecture
git rev-parse origin/refactor/empire-treasury-rearchitecture
git log --oneline -8
```

本地或远端不是预期起点时，列出增量，不自动reset/rebase/amend或套用旧包。仅文档变化可记录后继续；运行代码、依赖或构建入口变化须重新界定验收来源。

核对 `src/config/treasuryReadOnly.ts` 默认 `enabled=false`、空 `shardName/rooms`，LAB的 `enabled.ts` 仍为false。读取当前 `rollup.config.js`、`scripts/lib/deployGuard.cjs`、现有监控入口和相关说明，先区分读、构建、上传和激活动作。

### A2. 识别真正的线上对象

用受授权的只读通路取得并保存：

- 实际服务器API基址/类型、账号身份、目标shard。
- 账号的代码分支列表及活动标记，明确 **Git工作分支、Screeps代码分支、shard三者不是同一个字段**。
- 目标活动分支的完整模块集合及实际内容；每模块字节数/SHA-256，以及按仓库 `computeModulesHash()` 得到的集合摘要。恢复所需原始模块存于受控本地备份，不仅保存摘要。
- 目标shard中现有部署记录，例如 `lastDeployCommit`、`lastDeployTree`、`lastDeployBranch`、`lastDeployTag`、`lastDeployBundleHash` 和观测时间。缺失字段原样标缺失。
- 当前存活的自有房间及候选Storage/Terminal身份、可见性、所有权和容量；选取候选所需信息即可，不抓取无关账号、其他玩家Memory或全部历史。

必须核对该活动代码分支是否还被其他shard或运行环境使用。观察器自身的shard过滤只限制新增诊断，不会把整份上传自动限制在一个shard。如果一次覆盖会影响未授权范围，停止在部署前；不自行创建/切换代码分支来扩大权限。

部署Memory标签是旁证，不单独作为当前活动字节的真值。标签与模块不一致、脏构建或无法溯源时，保留原件并给出不确定性；不能从 `lastDeployCommit` 一个字符串直接认定线上等于某个Git SHA。

**本轮未知的host/shard/branch/账号由上述读取确定，不提前硬编码。**

### A3. 相关状态只读核对

只读取解释部署兼容性所需的相关分支或摘要，记录源时刻：

- 现有 `runtime.treasuryCore` 的存在性/版本、是否有活跃义务及其phase、旧存储是否存在；无法安全解读时保留“未知”，不填active=0。
- 现有任务、资源预留及其版本/完整性；必要路径包括 `data.resourceControl`、`runtime.resourceReservations` 及其owner版本。
- 既有生产、物流、市场等配置和已启用模块，用于确认候选代码不会激活额外writer。
- 当前CPU/bucket、既有主循环错误/监控信号，以及拟采样端点的基础状态。

缺失、空、损坏、不兼容和未读取分开写。不得调用带迁移或清理副作用的getter来让结果变健康。不同时间取得的API快照不构成同tick原子快照，不能仅因跨tick库存不同就报双扣。

不要求所有存储“健康”才允许观察；已知阻断可以作为观察对象。但新代码若会因读取/生命周期首次运行而执行未部署过的迁移或清理，已超出本任务的只读功能上线边界。

### A4. 给出部署差异判断

将实际线上代码与拟用的正常生产源码/构建比较，分开列出：

| 差异类别 | 本轮处理 |
| --- | --- |
| 已验收的观察器模块、一个主循环诊断挂载、限定profile | 可作为小范围候选，但仍需字节与授权核对 |
| 明确定位的构建时间/提交标签/树摘要等元数据 | 单独解释，不声称文件hash相等，也不宽泛剥离所有字符串掩盖业务差异 |
| facade/kernel/生命周期、生产/物流/市场/Defense、Memory迁移或依赖变化 | **停止部署**；这是基础迁移或其他功能发布，不是只读增量 |
| 来源无法确认、未知活动分支、模块冲突或共享影响范围不明 | **停止部署**；输出具体缺失项与可行的核对办法 |

源码对比之外，也检查实际构建的模块集合：残留模块、新增运行入口、资源模块及source map处理都要与上传方式一致。不能靠文件名里有 `readOnly` 判断只读。

阶段A必须给出明确结论：**可做窄增量采样 / 需要单独迁移方案 / 身份或授权不足**。若线上还没有同一国库基础，禁止把本分支整体上传或把观察文件硬摘到旧版本上；报告最小待迁移差异，由后续实现包处理。

---

## 5. 阶段B准入与本轮固定profile

仅当阶段A证明差异可控、没有额外业务/迁移变化、旧代码可恢复、受影响范围与部署/关闭授权都明确，才进入本节。

### B1. 提交一次明确的采样计划

先记录目标服务器/账号/shard/活动代码分支、采样房间/资源、拟部署源码、现有模块备份、关闭办法和截止条件。执行会话若已有覆盖这些范围的条件式授权，无需再逐命令确认；否则仅确认这份合并范围。

本轮采用以下**执行约束**，它们是本任务的采样安排，不是上一轮已经实测的结果：

| 项目 | 本轮安排 |
| --- | --- |
| shard | 一个实测确认的shard；同时明确同代码分支的全部影响范围 |
| 房间 | 显式1–2个自有房间，优先选择有稳定Storage/Terminal的普通生产房；不自动扩展到全帝国 |
| 资源 | `energy`及一种明确选定的资源，默认H；范围必须在启用前固定 |
| 位置 | 沿现有实现，仅Storage/Terminal |
| 频率 | `intervalTicks=100` |
| 工作预算 | `maxSampleCpu=2`、`reserveCpu=5`、`minBucket=2000` |
| 输出 | `maxLogBytes=16384`，保持有界JSON；不打开全量原始Memory日志 |
| 时间上限 | 首次上传请求起最多90分钟，且活动身份确认后最多1200个游戏tick，先到关闭 |
| 正常提前收尾 | 取得至少10份覆盖充分的采样，至少9份可关联的前一采样完整CPU成本，且各项分析材料已齐备，即可提前关闭 |

没有足够样本时不扩大房间、不降低bucket门槛、不提高CPU/输出上限、不延长截止时间，也不重新部署来清除故障停用状态。结束后如实给出覆盖不足或预算问题。

全程不制造一笔H转运、不暂停搬运者、不修改仓储来让数字好看。观察原来就在进行的业务，不是让生产环境复刻合成fixture。

### B2. 关闭能力先于启用

当前观察器只在模块创建时读取并冻结编译配置，没有运行时开关或自动到期机制；终止本地收集器不会关闭线上观察器。[S3][S7]

启用前必须准备并核对：

- 原活动分支的**完整可恢复模块原件**；其业务基础与候选除观察增量外一致，恢复不会退回不兼容的国库/Memory版本。
- 明确谁执行关闭、使用哪个已验证API通路、覆盖哪个账号和分支，以及关闭请求失败时的处理。
- 默认关闭路径优先恢复到原来已经在运行的同业务基础模块；不能在故障时临时从旧Git版本重编译并假装等同原产物。
- 在线读回并确认活动身份与备份仍相符，排除别人已更新代码。这里不是服务器原子CAS；约定本窗口部署由一个执行者负责，不另造持久锁。

正常关闭与异常回退均不得写入旧Memory快照，不清空任务/预留/unknown，不重新初始化服务。若识别到外部并发部署，禁止盲目覆盖别人新版本；停止自动操作，保留当前线上身份并报告冲突。

没有可靠的代码关闭通路就不启用。绝不使用standalone的暂停、进程终止或 `killall` 思路关闭正式服bot。

---

## 6. 配置、验证与真实上传

### B3. 默认关闭验证与启用profile验证分开

上轮默认关闭代码的完整结果可以按身份继承。必要的本地复验只在关闭基线做一次：

```sh
npm ci
node --test test/treasury-read-only/local.spec.cjs
npx tsc --noEmit -p tsconfig.build.json
npx tsc --noEmit -p tsconfig.json
npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  src/main.test.ts test/treasuryReadOnlyObservation.test.ts \
  test/treasuryReadOnlyIndependent.test.ts \
  --json --outputFile /absolute/new-evidence/default-profile-jest.json
```

若直接继承而不重跑，记录来源SHA/文件与未变化依据，不能填“本轮执行通过”。不机械再次运行全仓压力组或 `verify-jest-budget`；后者自身会执行全仓，不是廉价的静态计数查询。[S2]

随后仅修改并提交 `src/config/treasuryReadOnly.ts`，形成独立 `PROFILE_HEAD`。保留原预算数字；未新增测试就不滚动预算。

**注意：现有测试包含“交付配置必须默认关闭”的显式断言。** 启用配置会使该断言不再适用，不能删断言、改成true后仍称默认关闭测试通过，也不能偷偷把源文件改回false测试再上传true。

启用候选的验证应包括：

1. 两套真实项目类型检查；main阶段顺序与实际facade读取行为的定向复验。
2. 直接读取 `PROFILE_HEAD` 的真实配置，核对服务器计划中的shard、房间、资源和所有阈值；用已验收的配置校验函数检查，不使用另一份重新写的配置代替。
3. 用测试端口注入真实profile运行原观察器，检查正常采样、错shard零查询、Memory零尝试写入、非法范围拒绝和关闭对照。测试可模拟世界，但不能声称这是线上结果。
4. 在真实生产装配的本地隔离测试中验证启用配置可产出预期日志，仍调用原只读端口且异常不阻止原main收尾。

需要复用现有Jest行为用例时，可以明确选择不依赖交付默认值的子集，例如：

```sh
npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  src/main.test.ts test/treasuryReadOnlyObservation.test.ts \
  test/treasuryReadOnlyIndependent.test.ts \
  --testNamePattern='^(?!.*(?:runs the independent Node and real-main attachment tests|§5\.1 生产装配默认关闭)).*$' \
  --json --outputFile /absolute/new-evidence/enabled-behavior-subset.json
```

这里排除的仅是：作者的整个Node wrapper（其中含真实默认关闭断言），以及独立测试中的默认关闭运行用例。其完整覆盖留在关闭基线；Node中的通用行为需要时单独选择运行。将实际被选择/未选择的用例及原因写清楚，这**不是30/30全套通过**，更不是新全仓通过。过滤规则须按实际测试名核对，不能用过滤隐藏其他失败。

profile变更后，用干净工作树构建；所有构建身份都指向实际输入SHA。收尾恢复false后再运行完整默认关闭定向组，防止启用配置残留在最终交付。

### B4. 上传工具已有行为，不得误用

已读源码中的事实：[S4][S5][S6]

- `npm run build` 是 `rollup -c`，但只有 **DEST确实未设置** 才是build-only。
- `npm run push` 是 `rollup -c --environment DEST:main`，会**重新构建并上传**；不是把先前build-only文件原样上传。
- 目标来自 `.secret.json` 的对应配置；`DEST:main` 不代表Git的main分支，也不自动代表本轮批准的Screeps代码分支。
- `copyPath` 会走复制路径而非通常的API上传；默认分支回退和 `branch:auto` 都必须与本次实际目标核对。
- 生产守卫拒绝脏树等状态，但存在开发override和默认分支回退，不能认为“守卫没报错”就证明目标正确。
- 插件会对上传模块读回做比较；API返回ok本身不是字节确认，更不是活动运行确认。

禁止 `DEPLOY_ALLOW_DIRTY=1`，禁止通过 `npm run local`、绕开守卫、手改 `dist/main.js` 或更换构建入口进行生产上传。目标分支必须已存在并在计划内；不借上传脚本的clone路径创建意外分支。

可执行的build-only模板：

```sh
# Git Bash / sh：保存非敏感环境确认；不要打印完整env。
unset DEST
unset DEPLOY_ALLOW_DIRTY
npm run build
```

若用PowerShell则用等价的环境移除操作。先记录实际shell，不直接混用语法。

部署命令只在A和B全部准入、账号/分支明确、配置已提交、关闭通路已准备时使用。允许沿现有守卫执行 `npm run push`，但必须按**本次上传时新生成的真实产物**记SHA/字节/配置，不沿用此前build-only摘要。涉及原样模块恢复的操作，使用审阅过的现有API通路和相同模块比较算法；不得放宽原构建守卫。

### B5. 三种摘要分开核对

1. **最终文件SHA-256**：对本次真实 `dist/main.js` 全字节计算。
2. **内嵌/Memory的bundleHash**：当前rollup在追加 `globalThis.__DEPLOY_BUNDLE_HASH__=...` 之前计算，不能要求它等于最终文件hash。
3. **模块集合hash**：复用 `computeModulesHash()` 的名字排序与内容规范化算法，同时核对缺失、多余和不同的模块。

buildTime、commit/tree、目标分支等元数据差异只允许逐项解释；不能一律把所有差异当作元数据。按真实上传模块合计检查大小与服务限制，不把历史约4.94MB的单文件数字当作本次一定能上传的保证。若需要删除业务代码、修改依赖或构建器才可上传，停止并交回实现方。

### B6. 上传后的事实确认

上传前再次读回活动分支与模块，与A阶段备份核对，防止覆盖他人新部署。上传后保存本次API结果、实际本地产物、目标分支模块读回；确认模块内容精确一致。

再取得真实玩家运行后的部署身份与采样来源，确认是目标活动代码在目标shard执行，而不是上传到了不活动分支。只读观察日志本身不含完整源码SHA，需与同一收集窗口中的代码/部署身份联合关联。[S7][S8]

上传结果异常、目标不符、模块不一致或没有运行身份时，先调查读回，不盲目再次上传启用代码，也不开始用日志凑样本。无法确认则按已批准关闭方案恢复，状态保留未证实。

---

## 7. 有界采样与独立判读

### C1. 收集方式

采集原始用户console信封、接收墙钟、其中的游戏tick和可得的活动身份信号；保留原文，再离线解析。按目标用户、shard、kind和已确认的部署窗口筛选。HTML实体解码只作用于派生副本，不改写原件。

本功能日志是 `kind="treasury-read-only"` 的console JSON，不写新的Memory历史。**仅运行Memory轮询工具不会自动获得这些console样本。** 使用已有、经过验证的console订阅/读取通路；需仓库外薄收集脚本时，限定账号和连接范围，保存实际订阅身份，支持有界退出，无自动延长窗口。

现有 `monitor-service.mjs` 可辅助读取既有监控快照，但不是观察器的console采样器，也不保证导出所有Treasury字段。其自动选shard会按现有数据时间选择，本任务必须明确 `--shard`，不得依赖自动选择。[S9]

辅助命令示例（仅在对应线上只读授权覆盖时；凭据通过已有安全环境提供）：

```sh
node scripts/monitor-service.mjs --help
# 替换为A阶段实测并获准的BASE_URL、SHARD；未绑定时不得执行。
node scripts/monitor-service.mjs --once --no-http \
  --base-url "$BASE_URL" --shard "$SHARD" --output off \
  > /absolute/new-evidence/monitor-before.json
```

记录并排除 `SCREEPS_MONITOR_MEMORY_FIXTURE` 等测试输入对真实读取的影响，不打印token；不把monitor的截断输出当完整原始Memory，不把它的自动归一化状态当最终健康真值。缺字段时使用受授权的窄路径读取，不改生产导出系统。

关闭时停止本次订阅/进程，但只终止你自己启动的本地采集任务，不关闭用户既有监控，更不停止正式服进程。

### C2. 覆盖不能只数 `sampled`

为每个计划采样tick分类：完整、部分CPU、省略输出、读失败、旧观察、错范围、未取得样本或来源不明。没有console行时，仅凭沉默不能断定是CPU跳过；还可能是配置未启用、故障停用、未执行到phase或采集通道中断。

一份计入“覆盖充分”的报告，至少满足：

- 来源部署、目标shard、房间/资源范围正确，`authorizesActions=false`、`strategyPolicyEvaluated=false`。
- `observationTick`等于该样本tick且 `observationStatus=current_tick`。
- 计划端点均有明确状态；A阶段确认存在且可读的端点，本次必须取得独立实物、comparison和所选资源balance/容量信息。计划内确实不存在的建筑记N/A，不计成“健康零库存”。
- 没有因CPU或输出限制漏掉本轮要检查的字段；kernel、承诺完整性、市场线索状态都可判读。日志缺失可被正确表达为absent，但不能被当作“没有writer”。

`sampled`只是产出了一份报告，可能含stale/unreadable/blockers。所有样本均保留，不删除不利样本、不只统计成功子集。达到上限仍不足10份覆盖充分报告，给出有限覆盖结论，不靠换配置或延长窗口刷通过。

### C3. 数量与义务语义

独立核对实物与Treasury observation指定范围是否一致；差异具体到房间、位置、结构ID、资源或容量，不用一个总mismatch数代替。

保留query的 observed / committed / spendable、context/commitment状态、授权阻断、writeReady和风险调整空位。即便正数余额或writeReady=true，也不授权任何动作：该查询没有评估具体战略储备policy。

房间级 `outgoing/incoming/productionReserved` 不在Storage和Terminal之间重复相加；端点spendable也不能相加后宣称可花费的房间总额度。没有新建第二套账本。未知/损坏kernel的activeCount=null不是0；旧存储存在不能被健康空数组掩盖。[S3][S7]

若出现未解释的实物mismatch、观察器故障停用或明显数值不一致，保存原始报告和当时有限状态，停止继续扩大采样并执行关闭。原有承诺不完整或业务阻断可作为观察发现完整记录，不直接认定是新观察器bug，也不能为通过验收清理它。

### C4. writer归因只给线索，不编造结论

市场日志仅是已有 `marketActionJournal` 的有界投影。区分记录时间、actor、kind、intent/ok/blocked，以及省略、过旧、缺失、损坏。它不是完整Terminal或搬运流水。

相邻样本净变化只标为未归因变化：净零不能证明没有动作，energy减少不能直接视作运费，H减少不能直接归给某个模块。跨结构ID/容量变化、间隔太长或heap重建不比较。

第一轮仅结合**当前线上代码实际调用链**和日志列出候选端点的潜在writer；没有完整动作证据时注明未覆盖。不得临时包装Game写API、停掉writer或插入逐creep审计来“补齐归因”。未来单笔线上写入仍需单独解决端点竞争与真实储备政策。

### C5. CPU、输出与状态体积

报告至少包括每份输出的UTF-8字节数、采样前序列化成本、可关联的 `previousRun.totalCpuIncludingEmit`，以及实际可得的原profiler/主循环CPU信号。

- `maxSampleCpu=2` 是协作式工作预算，不能宣称硬上限。同步getter、全局索引重建、序列化和emit都可能越过检查点。[S3][S7]
- `cpuBeforeSerializationAndEmit`不是完整成本；下一份报告中的previousRun描述**上一份采样**。按previousRun.tick关联，一份成本不能重复计数。
- 首次冷启动、普通采样、partial/output_limited与故障分别报告；给出实际样本量及min/median/p95/max，若算p95说明算法。小样本p95只是该窗口描述，不是长期性能保证。
- 最后一份完整成本若没有后续样本或现成profiler支持，就明确缺失，不补造。正常目标10份报告/至少9份关联成本正是为此保留差别。
- heap中primitive字符数只是体积代理，不是VM堆字节，也不是整个bot Memory大小。原bot Memory会继续变化，不能要求全局JSON恒定来证明新增观察器零写。

不为采样擅自打开原CPU profiler或写Memory配置。已有监控不可得时，保留“整bot性能影响尚未量化”的限制；仅凭观察器自己的计时不能给整个国库的总成本背书。

本轮操作停止线：观测到新主循环异常/超时、观察器明确故障、采集来源失真，立即关闭；一次可关联的完整成本超2需明确记为越过目标，连续两次超2或持续预算不足则关闭并报告预算不适配。不得在线调高阈值来消除告警。该停止线是本任务安排，不是声称实现已具有运行时硬熔断。

---

## 8. 关闭、回退与失败处理

任何一种结束都执行已准备的关闭方案：达到正常样本目标、游戏tick上限、墙钟上限，或发生预算/读取/身份/主循环异常。外部连接重建不重置首次截止时间，不重新部署来清除heap故障锁，也不自动开启第二次观察窗。

正式服不能暂停世界等你整理日志。关闭是将观察功能从活动代码中移除/恢复默认关闭，而不是停止采集后放任线上观察继续运行。

关闭前重新检查当前活动模块仍是本次启用产物；一致时恢复已批准的原模块集合（或预先验证的同业务关闭产物）。读回比较全部模块，确认目标活动分支已经运行关闭代码，原业务仍正常。若出现别人新部署的版本，不擅自覆盖，应报告并协调当前状态。

若通过源码配置关闭：恢复 `enabled=false`、空shard/rooms的默认交付配置，以新线性提交保留启用历史；默认关闭定向测试完整通过。**本地恢复false或Git提交成功不等于线上已经关闭**，线上仍须实际模块读回与运行身份确认。

若上传/恢复超时，先只读确认实际远端状态，不能把超时等同“没上传”后循环覆盖。关闭失败或身份不明，明确标 `关闭未确认`，报告当前仍可能运行的版本与最后确认时刻。不能以进程退出/本地脚本exit0代替线上关闭事实。

整个关闭过程不还原、清空或重建Memory，不删除国库活跃义务，不释放unknown，不恢复旧任务快照。既有义务的正常观察与收尾继续属于原bot。上线配置不兼容的基础版本绝不能作为“紧急关闭观察器”手段。

---

## 9. 交付结果与验收

### 9.1 分开给出四个结论

| 结论维度 | 必须回答 |
| --- | --- |
| 线上基础 | 实际线上身份是什么？相对于候选代码是否存在非诊断变化或迁移风险？ |
| 代码部署 | 有没有上传/覆盖/切换？哪份源码与哪组真实模块在何处实际运行？未执行就写未执行 |
| 采样结果 | 覆盖多少计划tick/端点/资源？数量是否一致？发现哪些阻断或未归因变化？实际成本和缺口是什么？ |
| 关闭状态 | 最后活动代码是哪份？观察器是否已关闭？模块读回和原业务运行是否确认？ |

推荐报告状态（只是报告标签，不新增运行时schema）：

- `ONLINE_BASELINE_REVIEWED / NOT_DEPLOYED`：完成阶段A，因迁移差异、身份或授权条件停在部署前。
- `READ_ONLY_SAMPLING_COMPLETE / CLOSED`：取得足够可关联样本并完成关闭，逐项报告数据发现；不等于所有业务状态健康。
- `READ_ONLY_SAMPLING_INCONCLUSIVE / CLOSED`：已采样但覆盖、成本或数据不足，仍确认关闭。
- `CLOSEOUT_UNCONFIRMED`：线上关闭尚未证实，不能隐藏在一个PASS后面。

无论哪种结果，本轮都不授予Treasury新writer的线上执行权。下一步能否安排单笔线上调拨，要根据本轮真实数据、writer范围和储备政策另行决定，不能因日志“没有红字”自动晋级。

### 9.2 最小证据集合

建议新目录：

`openspec/changes/empire-treasury-core-rewrite/evidence/treasury-read-only-online-0001/`

保留任务原件、准确SHA与继承验证索引、阶段A原始事实/模块摘要/部署差异、准入和profile、实际验证命令/退出码/JSON、上传与读回、原始console/派生解析、CPU与覆盖统计、关闭与最终身份、最终报告。未执行的阶段无需造空材料充数。

线上原模块和必要Memory原件存于受控本地备份，供恢复与独立复核；只把已审阅无秘密、范围必要的证据提交仓库。需要脱敏时保存原件的私有位置与摘要，对外副本注明脱敏范围，不把脱敏后的内容冒充原字节。禁止上传token、认证头、`.env`、`.secret.json`、整账号无关Memory或含凭据的历史模块。

派生摘要不能代替全部原始材料，但也不要求把真实账号全量状态公开。按需要提供有限原件；无法分享的部分明确说明，不猜测缺口。

### 9.3 Git与回归纪律

继续原工作分支线性提交；profile配置、必要测试、收尾关闭和最终证据尽量分开。GitHub `git push` 与向Screeps上传是两种操作，日志明确区分。不merge主分支，不amend已push提交，不rebase/force，不删除旧失败原件。

每个实际产物记录源码HEAD、tree、配置、构建命令与真实字节；报告区分关闭基线、启用 `PROFILE_HEAD`、实际运行产物、最终交付HEAD。全仓248/1539只能按历史归属引用；本轮配置定向测试不冒充新全仓。

阶段A止步且没有代码变化时，只交差异与证据，不额外跑全仓。只改profile时跑受影响验证与关闭定向组，不反复全仓压力/预算。发现真正业务差异则停止本轮发布并交回，不以“补一轮全绿”代替部署审查。

### 9.4 最终回复必须给用户的内容

先说明是否部署、是否取得线上只读样本、是否已关闭；再给实际线上版本/候选版本/差异类别、样本范围与覆盖、数量和义务发现、CPU与输出成本、未解决项、精确提交SHA及证据路径。不要只回复 `PASS`，也不要让用户从几十份文件中自行猜测是否还在线运行。

---

## 10. 已核对来源与事实边界

以下路径均针对固定仓库版本，不表示已经核对实际线上账号。文中的90分钟/1200tick、1–2房间、10份样本和操作停止线是本轮执行安排；其余实现语义按来源核对，不用一般知识填补线上事实。

- **[S1] 远端HEAD。** 编写时GitHub connector读取 `commits?sha=refactor%2Fempire-treasury-rearchitecture&per_page=1`，返回 `828a078473c97562219d9cb5abfdd6df2ef5c79b`。
- **[S2] 上轮验收。** `openspec/changes/empire-treasury-core-rewrite/evidence/treasury-read-only-observation-i/treasury-read-only-observation-i-report.md`、`04-full-regression/jest-full.json`、`verify-jest-budget.log`、`05-second-tree/second-validation.log`。已审查结论为只读代码离线通过、未部署；第二树构建元数据差异不能称整文件字节相同。
- **[S3] 功能说明。** `docs/treasury-read-only-observation.md`：只读边界、端点/房间口径、协作式CPU预算、日志与heap语义。
- **[S4] 命令入口。** `package.json`：build/push/local与monitor脚本。
- **[S5] 上传行为。** `rollup.config.js`，Git blob `198fa51717435c9e4974f34227a0f196450dfa37`：DEST路由、重新构建、copyPath、附加摘要、上传与远端读回。
- **[S6] 守卫与模块摘要。** `scripts/lib/deployGuard.cjs`，Git blob `796e71d9b5572014fd2ce8e9a0ee797e4e04c7a8`：dirty/branch检查与 `computeModulesHash` / `diffRemoteModules`。
- **[S7] 当前观察器。** `src/runtime/treasury/readOnlyObservation.ts`，Git blob `cbca4b014fd3316c78add7aafac37312d46ff3a7`；`src/runtime/treasuryReadOnlyRuntime.ts`、`src/config/treasuryReadOnly.ts`；测试 `test/treasuryReadOnlyObservation.test.ts`、`test/treasuryReadOnlyIndependent.test.ts`、`test/treasury-read-only/local.spec.cjs`。
- **[S8] 部署旁证。** `src/runtime/deployAnnounce.ts`，Git blob `522f9cbcaa64e5bdc3888b9931a5467b5ba0acce`：部署后正常主循环写入的现有身份字段，不由新观察器写入。
- **[S9] 辅助监控。** `scripts/monitor-service.mjs`，Git blob `ea14da2efac8ca7c12491a604381c577348784ab`：显式shard参数、Memory轮询、测试fixture、自动shard选择与帮助入口；它不是新增console日志的完整收集器。

**执行终点：得到实际线上差异与一次条件满足才进行的限定采样。不是继续扩建国库，不是整体重构上线，更不是自动打开线上调拨。**
