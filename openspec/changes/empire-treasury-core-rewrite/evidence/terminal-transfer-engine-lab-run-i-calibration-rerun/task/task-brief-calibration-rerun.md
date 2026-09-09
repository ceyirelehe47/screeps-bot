# Terminal Transfer Engine Lab Run I — 实测配置校准与受控复验

**下一轮 Agent 实现与执行任务书 · 2026-09-09**

> 你是 `ceyirelehe47/screeps-bot` 的实现 Agent。请完成本任务限定的代码修复、独立配置验收、回归、证据归档和线性 commit/push；本机运行授权覆盖本轮时，再完成一次新的受控实验。不要只提交设计建议，也不要继续扩展 Treasury、重做接线或转入战斗系统。
>
> 本文是上一轮 `bd9570d…` 交付审查后的整改任务，不是旧 Wiring Remediation I 或 Execution Continuation 的重复执行。它包含实施所需背景，不要求你访问 ChatGPT 历史对话或下载另一个审查附件。本文规定语义与验收边界，内部数据布局和辅助工具接口由你实现，不新增固定 schema。

## 0. 唯一目标、范围与授权

本轮只解决一件事：**让一次真实 Terminal 实验使用可独立核验的正确配置，并在不放宽保护的前提下取得真实处理结果。**

先移除没有事实依据的“缺失 shard 可通过”分支；再让待验证配置与独立保存的玩家视图基线逐项比较；最后，在已有明确授权覆盖的情况下，执行一次新的 `W1N57 → W10N57 / 100H` 原始 API 实验。

本轮成功不意味着 Treasury 生产 writer 已经接入，不意味着正式服部署放行，也不覆盖部分转运、故障恢复或自动重试。

### 0.1 运行授权不是由本文代授

旧执行报告记载，用户在实现 Agent 会话中曾说：“我给予你离线授权, 不接入线上服务器即可”。不要错误地宣称从未有过本机实验授权；但本任务的编写方只见到了报告中的转述，不能把它扩成永久或无限次数许可。

你应核对**自己执行会话中的原始用户指令**：

- 明确覆盖本轮新建本机一次性世界、合成用户、装载实验代码及最多一次 `send(100H)` 时，按本任务直接执行，不要求用户逐命令确认或重新复述口令。
- 只覆盖已经结束的旧实验，或新运行范围确实不明确时，只做一次范围确认。在此之前继续完成离线修复、测试、文档与提交；实机部分报告 `AUTHORIZATION_REQUIRED`，不要编造新配置或新运行事实。
- 不得以“旧轮 send=0、额度未消耗”为由自动续跑。新实验也不能在失败后换 ID、改 T 或清 attempted 试到成功。

“本机离线实验”在这里指不接入线上游戏服务。依赖安装与 Git 提交按既有开发流程进行；不得使用真实 Screeps 账号、凭证或任何既有世界。

### 0.2 本轮唯一允许的游戏业务

| 项目 | 限定值或规则 |
| --- | --- |
| 场所 | 新目录、新存储、新世界；官方 standalone；仅本机监听 |
| 用户 | 一个新建合成用户拥有两端；用户名和用户 ID 必须实际读回 |
| 路线 | `W1N57 → W10N57` |
| 资源与数量 | `H`，`100` |
| 调用数量 | 最多一次真实 `terminal.send()` **调用**，不是最多一次成功 |
| 调用时刻 | 仅 `Game.time === targetTick` |
| 正式观察窗口 | `T−2 … T+20`，共 23 tick；`maxSamples=32` |
| 正式恢复后的停止上限 | 180 秒墙钟或完成 T+20 窗口，先到者触发停止 |
| 费用上限 | 从本轮稳定、新鲜的真实报价按本任务固定；发送时超限仍拒绝 |
| 禁止 | 正式服、PTR、既有私服、真实账号、市场、自动补货、自动重试、国库接线、故障注入、第二笔发送 |

管理员布置 fixture 与玩家 `send()` 分开记录。不得修改引擎经济处理函数、替换 Game、自造交易、补造 incoming/outgoing 镜像，或在发送后用管理员改库存做出成功结果。

## 1. 仓库与继承基线

### 1.1 已重新核对的版本

本任务编制时通过 GitHub connector 再次读取了分支 HEAD、预算文件和验证 SHA，仍为以下版本。[R1–R3]

| 项目 | 值 |
| --- | --- |
| 仓库 | `ceyirelehe47/screeps-bot` |
| 分支 | `refactor/empire-treasury-rearchitecture` |
| 本轮预期起点 BASE | `bd9570d2c3cf8632202cfee4e3a96d95250add52` |
| 上轮正式验证 HEAD | `54d067683ee18548d1331e2d2e11b25150e8e40a` |
| 上轮预算 baseline/target 锚点 | `3a9fceb200c1aaf7abd0503d3697c4b4e9e6ddc7` |
| 严格门禁的前置参考版本 | `8c5459c4ca40a6fd06494e4cad519e20d0cd7533` |
| 持续生产源码冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 当前 OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |

上轮已归档、经前次审查读取的全仓结果为 **241 suites / 1478 tests / 1478 passed**，failed/pending/todo/runtime error 全 0。这是上轮本地验证事实，不是本轮结果，也不是独立 CI。

上轮定向结果：LAB 2 suites / 35 tests（probe 23、runI 12）；Slice 0 3 suites / 23 tests；Treasury 35 suites / 597 tests；Defense 11 suites / 118 tests。集合有重叠，不能相加。新增或替换测试后，本轮数量以真实收集和运行结果为准，不为维持 1478 保留错误断言。

### 1.2 开工核对

先查看工作区、当前分支与远端。不要覆盖已有未提交改动，也不要 `reset --hard` 到本文 SHA。

```bash
BASE=bd9570d2c3cf8632202cfee4e3a96d95250add52
STRICT_BASE=8c5459c4ca40a6fd06494e4cad519e20d0cd7533
PROD_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
BRANCH=refactor/empire-treasury-rearchitecture

git status --short
git branch --show-current
git fetch origin "$BRANCH"
git rev-parse HEAD
git rev-parse FETCH_HEAD
git log --oneline --decorate -12
git diff --name-status "$BASE" HEAD
```

远端前移时先检查增量，避免重复实施已经完成的修复。仅新增证据等不改变任务前提的变化，可顺着最新后代提交继续并记录实际起点；存在未审查的相关代码变化、分叉或不明工作区改动时，保留现场，暂停受影响的修改与实机步骤，不强行覆盖。

### 1.3 必须继承，不得重新打开的内容

生产 Treasury Core 使用 `Memory.runtime.treasuryCore`、schema v3、`tk1_` attempt ID。不要退回旧 Ticket/GRA/多权威修补路线。

以下机制保持原实现和既有测试：

- 国库持久关窗、安全收尾、unknown 风险占用、有界 Memory、业务退出和防重放；不得用年龄/FIFO 清掉未决义务。
- Slice 0 的固定路线、单在途、严格交易归属、不同 ID/矛盾镜像保持 unknown、费用绑定冻结授权、真实 query 占用口径。
- `runIMain` 的单向依赖：observer 装配/调用失败阻止本次 single-shot；single-shot 缺失不阻断后续只读观察；void 返回不升级为健康凭证。
- `singleShot` 发送前 attempted 写入并读回、发送后记录失败不撤销 attempted、完整 JSON 的 4096 UTF-8 字节边界。
- 生产入口、经济装配、共享类型与 Defense 冻结。

脚本内 Memory 写入后读回，只证明脚本当时看见该值，不证明 driver 已持久化，更不能宣称数据库式 exactly-once。

## 2. 上轮问题与事实边界

下表是本轮修复依据，不是新世界配置模板。[R4–R7]

| 项目 | 上轮编译值 | 已保存的事实 | 本轮处理 |
| --- | --- | --- | --- |
| 源 Terminal ID | `b0254105a49b92c` | 初始化、正式窗口和终态为 `b0254141a49b92c` | 补入纠错；新世界重新读取并比较 |
| shard | `standalone-no-shard` | T557 原始拒绝为 `shard_mismatch`；后续只读探查显示实际 `Game.shard.name="Forst"` | 撤销缺失身份放行；新世界重新读取 |
| 费用上限 | `10` | 正式窗口报价为 `26` | 使用新鲜报价绑定新实验；保留超限拒绝 |
| 验收 fixture | ID、shard、报价由待验 config 生成 | 只能证明接线自洽，不能发现回填错误 | 增加独立事实与配置的比较 |
| 运行证据 | 报告称若干阶段全部满足 | 安装 lock、活动模块回读、控制槽、停止等部分原件不足 | 可找回则补交；丢失则记缺失；新轮同步保存 |

必须保留以下区别：

**第一，Forst 来自后续探查，不是 T557 同 tick 的直接 shard 记录。** 不得把后续字段拼进旧样本并冒充原始观测。旧 T557 确认的是探针前置拒绝，不是游戏 API 返回 ERR。

**第二，“无 shard 分支行为等价”是错误结论。** 在其他条件合法、Game 缺 shard、配置填写 sentinel 的同一输入下，旧门禁拒绝，现行门禁可放行。接受集合扩大了。

**第三，“报价变化证明固定费用上限不兼容”是错误结论。** 26 大于已固定上限 10 时拒绝，正是预算保护正常工作。不能通过扩大上限、把实时报价写回旧授权或跳过比较来使实验通过。

**第四，报价 10→26 的观测不等于其完整原因已证实。** 地图生成、world size、缓存之间的完整因果尚未独立核实。本轮只需先完成初始化，再读取稳定事实，不另开引擎机制研究项目。

旧实验结论仍可保留 `ENGINE_LAB_INCONCLUSIVE`：真实 runner 与采样已运行，但没有正常 100H 转运证据。不得改成“全部实机 NOT_RUN”，也不得因本轮复验成功而重写旧轮结论。

## 3. 允许修改的范围

### 3.1 允许

1. `test/lab/terminal-transfer/sendGate.ts`：仅恢复严格真实 shard 身份读取及对应健康检查。
2. `test/lab/terminal-transfer/labConfig.ts`、`example.experiment.json`：移除无依据 sentinel 约定，纠正现行说明；取得本轮新事实后合法回填。
3. `probe.test.ts`、`runI.test.ts` 和少量新增 LAB 测试/fixture：覆盖本次反例、合法对照与独立配置核对。已有接线覆盖不得削弱。
4. 一个足够小的本地配置核对工具，以及必要的只读元信息采样、收集、限时停止辅助工具。优先复用旧管理与收集脚本，补齐本轮必需能力；不建立通用平台。正式使用的工具源码必须可追溯到验证版本。
5. OpenSpec 现行说明、本轮任务/纠错报告/证据索引；历史原件保持不变。
6. `test/test-suite-budget.json` 与 `scripts/verify-jest-budget.mjs` 的真实数量、实现锚点和相应说明。校验算法、保护文件规则和禁止跳测规则不变。

具体新增文件名和内部接口由你选择，并在最终报告列出。新增只读工具不得写游戏 Memory、武装控制槽或调用 send；本地比较结果也不能成为游戏运行时的新授权字段。

### 3.2 不允许

不得修改 `runIMain.ts`、`observer.ts`、`singleShot.ts`、`controlRecord.ts`、`worldRead.ts`、`sample.ts` 的既有运行逻辑；此次元信息需求由单独只读采样解决，不扩写已经通过的 observer/main 协议。

不得修改两个 Slice 0 mock、Slice 0 测试与生产内核来迁就实验。不得修改根依赖、TypeScript/Jest/Rollup 配置或 `build-treasury-terminal-lab.mjs` 来加入上传、动态配置或新实验模式。

不得引入健康 token、新持久锁、动态预算协议、另一个配置权威、第二套余额或结算机制。玩家代码里值得借鉴的库存阈值、需求/富余、反振荡、成本排序、扫描节流，全部留待未来策略任务。本轮不实现这些优化，不启动 Tigga 对抗。

超出允许范围才可修复的实机兼容问题，应保存事实并将该部分报告为阻塞，而不是现场扩大本任务。

## 4. C01 — 恢复严格的 shard 门禁

### 4.1 实现

以前置版本 `8c5459c…` 的严格门禁为行为参考，通过**新的线性提交**撤销缺失 shard 的放行分支，不回滚整个仓库。

运行时只接受实际读取的合法 shard 名。Game.shard 缺失、为 null、name 缺失/不是合法非空字符串或读取抛错，都必须拒绝。合法字符串与配置精确比较；不同则拒绝。禁止 `String(shard.name)` 将异常值转换成看似可比较的身份，也禁止用约定字符串替代缺失身份。

删除现行源码对 `LAB_STANDALONE_NO_SHARD_NAME` 的导出、导入及其错误依据。历史归档产物、旧日志和明确命名的历史反例中可以保留该字面值，不能为了全仓 grep 干净改写历史。

其他 gate 顺序与资源检查保持不变。无需增加新状态机或新错误协议；复用现有拒绝表达即可。

尚无本轮新世界事实时，配置只能明确标为未绑定示例或历史配置，默认 observer，不得称为“已实测、可武装”。不要猜测新 shard/ID；最终回填放在 S02 之后。

### 4.2 测试

每个异常场景都必须搭配信息完整的合法对照，避免用一个始终拒绝的实现假通过。

| 输入 | 必须结果 |
| --- | --- |
| 缺 shard，配置仍声明旧 sentinel，其余条件合法 | 拒绝；零 send；不得进入 attempted 写入 |
| shard 为 null、name 缺失/非字符串/空串、读取抛错 | 拒绝；零 send |
| 存在合法真实名字，但配置名字不同 | `shard_mismatch`；零 send |
| 合法真实名字与配置相同，其他条件合法 | gate `proceed`；合法 single-shot 对照一次调用 |
| 信息完整但未武装、attempted=true、错过 T、超预算 | 继承原有拒绝；零 send |

shard 的健康依据是实际存在的合法值，不是给某个字符串加黑名单。即使某个合法世界真的取名与旧 sentinel 相同，也必须按真实存在与精确匹配判断，不能引入另一种假定。

原来“缺 shard 可以通过”的测试应改为明确拒绝的回归，不允许仅删除错误用例后宣称修复。用前后版本的函数级对照解释接受集合变化即可，不在生产代码中保留旧实现。

## 5. C02 — 增加独立配置验收，不再由 config 生成正确答案

### 5.1 实现边界

增加一个可在本机重复执行、无游戏写权限的小型核对步骤：

**读取固定源码实际使用的编译配置，与独立落盘的真实玩家视图及暂停事实逐项比较；全部通过才进入武装流程。**

比较工具可供离线测试与实际武装前检查共用，但不能从待验 config 反向构造基线、替换缺失事实，或只比较三个 manifest 是否相同。

配置仍只有 `labConfig.ts` 一条运行时编译来源。核对工具读取该版本导出的值，或读取可验证地由该版本导出的派生快照；不把手写 JSON 或复制出的第二份配置当权威。构建器当前的 `example.experiment.json` 是文档副本，manifest 记录构建身份，两者均不能单独证明配置来自真实世界。[R8]

输出应让 reviewer 看见：实际核对了哪些原始材料、对应文件/记录/tick、配置值与观测值、全部不一致项。存在失败、缺失、不健康、来源混用或陈旧问题时非零退出。字段布局和 CLI 参数自行选择，不需要 schema 或证书系统。

### 5.2 至少核对的内容

| 类别 | 核对语义 |
| --- | --- |
| 实验范围 | 新实验 ID/描述，固定路线、H、100、maxSamples=32；描述满足实际 API 限制，无已有同描述记录 |
| 世界与用户 | 实际 shard 名，合成用户 ID/用户名及证据来源；两端 owner 与该用户一致，不能仅从配置知道“自己是谁” |
| 端点 | 两个房间可见；实际 Terminal ID 与配置一致；结构存在、my/isActive、控制器状态合法 |
| 资源与容量 | 源 H 足够、源能源能支付固定上限、源 cooldown=0、目标总空位足够；缺失/不可读不转换为零或健康 |
| 报价 | 来自真实 `calcTransactionCost(100,A,B)` 的新鲜有限合法值；按本任务在最终绑定时令 cap=q；之后仍执行实时报价≤固定 cap |
| 时间与稳定性 | 两个以上不同 tick 的稳定基线、最后管理修改之后的元信息、暂停且稳定的 T0、T/窗口仍在未来且可完整覆盖 |
| 代码来源 | 实际待装载配置来自固定源码；代码、配置、工具版本和模块 hash 的对应关系可追溯 |

world size 是诊断事实，不是绕过报价比较的理由。没有必要把它新增为 runtime gate 字段。my/isActive 等本轮预检事实也不要求扩展已经冻结的发送协议。

正式 gate 保持遇错立即拒绝；**本地预检须一次报告所有可检测的不一致**。未获得某字段时记录“无法核对”，不能因为第一项 shard 失败而省掉源 ID 与费用检查。

### 5.3 独立反例与合法对照

至少覆盖以下组合；可合并成参数化测试，不要求每项新建一个文件：

**A. 旧事故链的门禁复现。** 固定独立世界 fixture 使用源 `b0254141a49b92c`、目标 `c61a4141a4a9fcb`、报价 26，shard 使用后续确实观察过的 `Forst`，其余满足条件。

```text
旧编译配置                         → shard_mismatch
只将配置 shard 改为 Forst          → structure_mismatch
再将源 ID 改为 b0254141a49b92c     → fee_over_budget
再在本测试中把费用上限设为 26       → proceed
```

这个 fixture 是**跨时间资料构造的离线诊断场景**，不是 T557 世界的无损重放；26 只用于历史反例与合法对照，不能成为新实验常数。任何函数测试都不计入真实引擎实验。

**B. 三项同时错误。** 本地预检一次给出 shard、源 ID、费用上限与本轮绑定规则不符三项差异，不只返回第一项。只修改待验 config 的一项，基线不得随之变化。

**C. 拒绝虚假自洽。** manifest、文档 JSON、待验配置彼此一致，但独立原始事实不一致时，仍拒绝；不得用配置修改“修正”原始事实。

**D. 缺失与混用。** 缺真实 shard/name、缺 Terminal 身份、只有一个 tick、读取错误、缺必要健康字段、不同运行/用户的资料混用，均不得验收通过。基线取得后又改 fixture/map 等管理状态，必须先重新取得新鲜只读事实，不能沿用旧通过结论。

**E. 预算边界。** 固定 cap=q 后，发送时报价等于 cap 可以通过，大于 cap 拒绝；报价读取异常/非法拒绝；不得自动改大 cap。测试中可使用不同于旧轮 26 的报价证明没有硬编码。

**F. 正常对照。** 独立取得的完整健康基线、匹配配置、未来 T 与合法预算，通过预检；实际三 bundle 的现有 VM 接线测试仍正常发送一次。

**G. 工具只读与真实使用。** 预检不会修改输入资料或配置、不会连接游戏写接口；其真实命令实际出现在本轮正式验证和武装前记录中。只有测试，没有运行该检查，不能通过 C02。

`runI.test.ts` 为验证接线仍可保留 config 驱动的假世界；明确它的用途。新独立比较测试不得沿用该模式，必须经过实际比较实现，不要在测试里重写一份永远返回预期值的“验证器”。

## 6. C03 — 纠错与旧证据处理

### 6.1 纠正现行说明

更新现行 `terminal-transfer-engine-lab-run-i.md`，使其顶部状态、历史执行段落和当前入口一致。不得继续在同一现行文档里一处写“实机仍 NOT_RUN”、另一处写“已运行”。

现行 `terminal-transfer-lab-run1-shard-gate-compatibility.md` 标记为**事实基础已推翻、实现已撤销的历史提案**，指向本轮纠错说明；不得继续把它当有效设计依据。

本轮纠错至少写清：源 ID 漏诊；缺 shard 分支改变接受集合；固定费用上限正确拒绝；Forst 的实际采样时间边界；world size 因果尚未完整证实；旧轮部分阶段证据不足。

### 6.2 不改旧原件

旧证据根保持已有文件字节与身份：

```text
openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i/
```

不要原地修改旧报告、console JSONL、快照、归档 bundle 或旧验证结果来“消除矛盾”。新建纠错文件并从现行说明链接即可。

仅对仍可取得的旧原件做一次有界查找：server package/lock、解析与启动记录、活动模块完整回读、武装/撤装控制槽、交易表查询、PID/监听停止记录。

找到则保留原文件内容，注明实际来源及此次取得时间；由现有旧原件解码产生的资料必须标为派生文件。找不到则列明缺失、原因和影响，不用新世界重新演示来伪造旧证据，不把报告文字生成 JSON 当原件，也不因此展开无止境恢复工程。

旧轮缺证与新轮验收分开：新轮证据完整可以独立通过，但不能反向补齐旧轮 S01/S05/S06。

## 7. 实施顺序与版本固定

按以下顺序在同一轮交付中完成，不拆成反复等待的 Prep 轮次：

1. 核对起点，完成 C01–C03，运行聚焦离线测试；准备好只读采样、预检、日志收集和停止工具。
2. 授权覆盖时完成 S01/S02：新环境初始化、真实只读基线、暂停稳定。尚未授权则完成离线交付，不伪造后续步骤。
3. 用真实事实最终绑定配置、实验 ID、描述、T 与 cap；预检通过；提交所有会用于正式判定或实际运行的源码、测试、工具与配置，记录该 **IMPL_HEAD**。
4. 根据真实 Jest 收集/运行更新预算数量与 baseline/target 引用。预算引用一个已存在、包含本轮测试文件集合的实现提交，不能引用不存在的自身 SHA。按现有规则更新 verifier 的锚点与数字，不放宽校验。
5. 提交预算及必要固定材料，记录 **VALIDATION_HEAD**；在这个 SHA 上完成 §9 全部正式离线验证及第二干净树复现。世界保持暂停。
6. 校验从基线到现在没有未解释的世界改变；执行实际预检；装载并回读模块，武装一次、运行一次、观察并停止。
7. 只追加本轮证据、纠错和报告，形成 **DELIVERY_HEAD**，commit/push 后核对远端。

最终验证 SHA 必须包含实际运行工具、判定工具和编译配置。验证后修改代码/测试/配置/运行或判定工具，旧验证对新版本失效；重新固定 SHA 并完成受影响验证。在尚未武装的开发阶段修复代码不算第二次发送；**一旦武装或正式窗口恢复开始，本轮不再改 ID、T、cap 或配置来重开正式窗口。**

不要把 IMPL_HEAD、VALIDATION_HEAD 和 DELIVERY_HEAD 混成一个“已验收 SHA”。证据追加提交不要求 SHA 自引用。

## 8. S01–S06 — 一次新的受控实机复验

### S01：新环境、授权、版本与隔离

使用与仓库分离的新实验目录；不复用报告称已清理的旧世界。记录用户授权范围、新目录、数据位置、监听地址、端口、启动命令、启动进程及子进程关系。启动前核对端口归属，不杀未知进程为自己腾端口。

优先复用上轮尝试的 `screeps@4.3.0` 安装方案，不借本轮升级引擎。上轮报告组合为 backend 3.3.0、common 2.16.0、driver 5.3.0、engine 4.3.0、launcher 4.2.0、pathfinding 0.4.17、storage 5.1.3；这些是历史报告，不是本轮已安装事实。

本轮保存**实际** server `package.json`、完整 lockfile、安装日志、`npm ls` 输出，以及从服务器启动位置解析出的核心 package 路径、版本与关键文件身份。核对是否意外解析到 bot 仓库依赖或全局安装。不能把以前阅读过的 engine/driver 参考 SHA 当作本轮 npm 包的运行版本。

旧环境兼容经验可以参考，但不能假定必定重复出现：CLI 管道断开曾导致 backend 异常，房间初始化曾涉及 terrain 刷新。需要本机 storage 管理时可复用归档工具，但只连接本轮 loopback 端点。不得修改引擎经济代码来绕过问题。

启动、初始化及只读阶段无控制槽武装。真实凭证不进入环境或证据；需要保存环境参数时只记录必要的非敏感参数，不导出全部环境变量。

### S02：先稳定世界，再读配置依据

暂停并确认实际状态稳定后，由管理员创建两个房间与合法 fixture。同一新合成用户拥有两个 RCL8 控制器与 Terminal；建议延续原场景：源 1000H/10000 energy、目标 0H/2000 energy。这些是初始化设置，不能代替之后的玩家视图。

完成所有地图/房间创建、必要缓存刷新及 runner 重启，之后停止管理侧对 fixture 的更改。管理操作逐项留记录，不边采基线边继续改地图。

加载真正只读的 observer 与必要的独立元信息采样。只读工具本身提前固定源码并记录 hash；不以 Node fake 或管理员存储记录替代真实 runner 玩家视图。若初始只读包使用占位实验配置，明确标为基线探针，未装载/未授权 single-shot；它不因输出配置字段就证明这些字段真实存在。

至少取得两个不同 tick 的稳定样本，记录：实际 tick、shard、合成用户身份、两端 ID/owner/my/isActive、控制器状态、库存/energy/总容量/空位/cooldown、world size、真实报价以及 incoming/outgoing 的原始记录与读取状态。额外元信息可由独立薄只读模块输出，不修改正式三件套。

合成用户 ID 可由真实 console 通道和管理侧新建用户记录的对应关系确认；用户名以实际玩家结构 owner 等读数交叉核对，记录各自来源，不杜撰额外的 Game 用户接口。

样本自身的真实字段必须区别于配置回显。身份、端点、报价和库存应在完成初始化后的基线中相互一致；记录最后管理操作与基线的先后关系。两个样本不构成“永不漂移”的证明，发送时仍有原有实时门禁。

证明用户 console 的实际收流可用，不能只留 launcher stdout。按合成 user ID 区分日志；默认 NPC 即使存在于其他房间，也不能声称全世界只有一个 bot，应证明没有影响两端和本实验的其他经济 writer。

出现相同完整描述的已有交易、样本错误、持续漂移、无法取得稳定基线或无法隔离影响时，保存原始事实，不进入武装；不要删除历史、修改样本或不断延长基线窗口去凑通过。

再次暂停并等待在途 tick 完成，重复只读核对以确认稳定，记录实际 `T0`。不能把“发出了 pause 命令”当原子停止，也不能拨动游戏时间。

### S03：最终绑定、固定代码、预检、装载与单次调用

**绑定。** 新世界的用户名、shard、结构 ID、报价、T 全部重新读取。不能照抄旧 `Forst`、旧两个 ID、旧 26 或旧 557。实验 ID 与完整 ASCII 描述应是本轮新身份，长度满足安装版本 API 限制。

本轮默认将费用上限固定为最新稳定报价 q，并确认源能源足够；以后报价超过该 cap 就拒绝。选择未来 T，通常为 T0+3，但先核对当前暂停点与下一实际 runner tick 的语义，保证 T−2 的样本可取得。不能通过修改 gametime 凑窗口。

同步 `labConfig.ts` 与文档 JSON，执行 C02，完成 §7 的提交及 §9 正式验证。保持世界暂停、配置不再变化。构建身份和真实配置来源两条链都要核对，不能互相替代。

**装载。** 使用正式验证产物，完整保存三个本地文件与 manifest；通过本轮管理入口加载后，从该合成用户的**活动代码分支**读回完整模块内容，重算 UTF-8 字节数与 SHA-256，逐一与待装载字节比较。记录活动 branch/user ID、读取命令与原始响应，不只保存三个 hash 字符串或“reload 成功”。

若返回形式包含序列化包装，保留包装原响应和解码方法，比较的是实际模块源码字节。不得手改生成 JS、改变换行后沿用旧 hash，或只检查本地复制目录。

**武装前最后核对。** 在暂停稳定、模块身份通过后，实际执行一次 C02 的正式命令并归档输出。核对没有发生使基线过期的管理变化，T 尚未错过，收集器和外部限时停止机制可用。预检失败不武装。

**武装。** 只对本轮合成用户写一次受支持的控制记录，匹配 experimentId、armed=true、attempted=false；不加入整份配置或新健康字段。保存武装前、写入请求与完整回读；独立核对完整 JSON 的 UTF-8 字节数≤4096。

恢复运行前记录墙钟时间和实际代码身份，启动/确认外部停止保护。单次调用只由现有 single-shot 在 T 发起；不由管理入口直接调用，不替换 send 做计数包装，不另加游戏内 writer。

### S04：真实窗口与结果判读

正式 main 仍运行 T−2…T+20，逐 tick 先 observer，仅 T 进入 single-shot。原样保存调用前、boundary、同步返回或异常、控制记录以及所有后续玩家样本。

记录实际首次可见效果和交易的 tick，不预设一定 T+1。若正常效果出现，窗口内至少保留之后两个连续、稳定的观察；效果出现太晚导致证据不足时不延长窗口补成通过。

用 T 前实际玩家状态定义 `H_A0 / E_A0 / H_B0 / E_B0 / F_B0`，用 T 时发送前真实报价定义 `q_T`。历史 q、旧 mock 常数和管理员初始化数不能替代这些数据。固定 cap 不变；正常发送的 `q_T` 必须不超过它。

| 项目 | 正常全量预期与判读要求 |
| --- | --- |
| 调用 | 恰一次 boundary；记录真实返回 OK。OK 只是调用被接受/安排，不能单独证明到账 |
| 源 H | 后续为 `H_A0−100` |
| 目标 H | 后续为 `H_B0+100` |
| 源 energy | 后续为 `E_A0−q_T`；和本次报价比较，不强填 26 |
| 目标 energy | 无其他动作时保持 `E_B0` |
| 目标空位 | 后续为 `F_B0−100`，读取实际容量接口 |
| cooldown | 记录实际版本常量及逐 tick 值，不要求预写数字一定出现 |
| 交易 | 保存两个原始视图；完整描述、参与者、路线、资源、实际 amount、时间与本次调用一致 |
| 控制事实 | 发送前 attempted 写入/读回与后续事实可追踪；不把脚本读回夸大为 driver 持久化证明 |

incoming/outgoing 中相同游戏交易 ID 的一致镜像只算一笔。相同 ID 矛盾、多个不同 ID 都关联本实验、amount 不一致、归属不清，不能挑一条“好记录”宣告成功。没有某一视图则保留事实；不得注入镜像或删除异议数据。

使用既有观察与本机只读世界/交易表快照交叉核对，保存交易表查询请求和完整结果。只有终态、只有 OK 或只有空交易数组都不足以断言整个正常流程通过；调用边界是否发生、调用次数是否确定，要分别写明。

console 原件按“外层 JSONL → payload JSON → messages.log 的 HTML 实体解码 → 实际 lab JSON”处理，另存派生结果与原行映射。保留原始字节，不把 `tickStarted` 的 payload="1" 当游戏 tick，不把其他 NPC 或后续 probe 的输出拼成本用户目标 tick。

**停止条件：** 超时、收集失败、读取异常、调用 non-OK/throw、重复调用、身份/路线不符、预算外变化或其他经济 writer 干扰，立即进入暂停/撤装/取证/停止流程。对于门禁拒绝和无发送，也不重新武装、不换 T。提前停止导致不满23样本就如实报告，不继续跑只为凑数。

### S05：停止、撤装与仅清理本轮资源

完成 T+20 的对应玩家观察/处理后请求暂停，或 180 秒墙钟先到时立即停止推进；记录实际最终 tick 和停止延迟，不声称 pause 是瞬间原子操作。

先取终态与控制事实，撤销武装，保留 attempted 和结果，不删除/重置控制槽掩盖运行历史。需要切只读代码时记录切换时刻、内容与活动分支。窗口结束 main 不再发送，不以停止操作代替原有门禁。

保存撤装写入与完整回读、两端终态、相关交易表和本轮执行进程信息。停止本次 launcher 及完整子进程组，核对不会因仅杀 worker 被 launcher 拉起。分别保存停止命令、退出结果、PID/进程匹配和监听端口检查原始输出。

证据已复制到实验目录外并核对可读取后，才清理本次新建目录/世界。清理范围与 S01 登记一致，留下操作及结果。禁止全局 prune、删除未知目录、停止其他服务、反向发送“归还资源”。

异常情况下优先停止风险；不能为补齐漂亮日志继续发送或长时间运行。无法确认停止/清理完成就明确写未确认，不自行宣布 S05 满足。

### S06：结论与证据完整性分开报告

| 最终状态 | 使用条件 |
| --- | --- |
| `ENGINE_LAB_PASS` | C01–C03 与本轮 S01–S06 均满足；新实验的正常100H调用、真实变化、交易、停止与证据完整 |
| `ENGINE_LAB_INCONCLUSIVE` | 已进入实验，但被 gate 阻断、关键事实缺失、未观测到充分结果，或证据不足以完整判定；不重试 |
| `ENGINE_LAB_MISMATCH` | 实际正常场景出现可复核的非预期 API 返回、数量、归属、调用次数等差异 |
| `ENV_BLOCKED` | 前置环境/配置/隔离条件不具备，未进入正式调用窗口；细列已做过的服务/只读活动 |
| `AUTHORIZATION_REQUIRED` | 新运行未获覆盖；离线成果与未运行部分分开写 |

因收集失败而不知道是否调用，不得写“send=0”；能证明 gate 在 boundary 前拒绝时，才按证据写零调用。实验前置阻塞不代表所有准备活动都没发生。

新轮若正常转运有证据但停止/来源原件不足，可单列“转运事实有支持，完整实验验收不通过”，不能强合成 PASS。旧轮的缺证项独立保留，不替换成新轮结果。

## 9. 正式离线验证与冻结检查

### 9.1 日志与运行方式

在 bot 仓库根运行，和 server 目录分开。先 `unset DEST`。禁止 `npm run push`、`npm run local`、`watch` 或其他生产部署入口；`git push` 只上传代码，不是游戏部署。[R9]

正式输出写到仓库外的新临时目录，避免运行中工作区变脏；之后按来源复制归档。每个命令保存完整调用、stdout、stderr、退出码；Jest 另存独立原始 JSON。Windows 可使用等价 PowerShell，但必须记录实际命令，不能照抄 Linux 输出为已执行。

下面的 Bash 示例提供可用的记录方式；辅助工具的具体命令由你的实现补入运行记录：

```bash
set -euo pipefail
unset DEST
BASE=bd9570d2c3cf8632202cfee4e3a96d95250add52
STRICT_BASE=8c5459c4ca40a6fd06494e4cad519e20d0cd7533
PROD_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
E="$(mktemp -d "${TMPDIR:-/tmp}/screeps-lab-calibration.XXXXXX")"
printf '%s\n' "$E"

run() {
  local label="$1" rc
  shift
  {
    printf 'cwd: %s\n' "$PWD"
    printf 'command:'; printf ' %q' "$@"; printf '\n'
    date -u '+start: %Y-%m-%dT%H:%M:%SZ'
  } > "$E/$label.command.txt"
  if "$@" > "$E/$label.stdout.log" 2> "$E/$label.stderr.log"; then
    rc=0
  else
    rc=$?
  fi
  printf '%s\n' "$rc" > "$E/$label.exit-code.txt"
  date -u '+end: %Y-%m-%dT%H:%M:%SZ' >> "$E/$label.command.txt"
  printf '%s exit=%s\n' "$label" "$rc"
  return "$rc"
}

git rev-parse HEAD > "$E/validation-head.txt"
git status --short > "$E/status-before.txt"
run npm-ci npm ci
run typecheck-all npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run production-build npm run build
```

运行前必须确认 HEAD 就是已记录的 VALIDATION_HEAD，工作区干净。任何失败均保留原件并停止放行，不能用 `|| true`、零收集或只摘最后一行掩盖。

### 9.2 正式测试集

LAB 使用整个实验目录收集，保证本轮新增比较测试不漏跑：

```bash
run jest-lab npx jest --config jest.config.cjs --runInBand \
  test/lab/terminal-transfer/ \
  --json --outputFile="$E/jest-lab.json"

run jest-slice npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts \
  --json --outputFile="$E/jest-slice.json"

run jest-treasury npx jest --config jest.config.cjs --runInBand \
  src/runtime/treasury/ \
  --json --outputFile="$E/jest-treasury.json"

run jest-defense npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  src/runtime/defenseFocusFire.test.ts \
  src/runtime/defenseFocusFireStateful.test.ts \
  src/runtime/defenseFallbackReallocation.test.ts \
  src/runtime/defenseAllActorReservation.test.ts \
  src/runtime/defenseGlobalRampartFootprints.test.ts \
  src/runtime/defensePreallocationRampartOwnership.test.ts \
  src/runtime/defenseStationaryRampartOwnership.test.ts \
  src/runtime/homeDefense.test.ts \
  src/runtime/towerControl.test.ts \
  src/roles/homeDefender.test.ts \
  test/memoryDeclarationBoundaries.test.ts \
  --json --outputFile="$E/jest-defense.json"

run jest-full npx jest --config jest.config.cjs --runInBand \
  --json --outputFile="$E/jest-full.json"
run budget node scripts/verify-jest-budget.mjs
```

本轮辅助工具测试若放在上述 LAB 路径之外，必须加入定向验证并列明路径；不能只靠“全仓应该会跑到”。所有集合检查实际非零收集、无失败/跳过/todo/运行错误；已有保护测试与预算规则不弱化。原先错误的正例改为拒绝回归，测试数量变化按原始结果说明。

### 9.3 三产物与配置核对

```bash
run build-observer node scripts/build-treasury-terminal-lab.mjs \
  --out "$E/lab-observer"
run build-single-shot node scripts/build-treasury-terminal-lab.mjs \
  --mode single-shot --out "$E/lab-single-shot"
run build-main node scripts/build-treasury-terminal-lab.mjs \
  --mode run-i-main --out "$E/lab-run-i-main"
run diff-check git diff --check
```

另外实际运行本轮 C02 比较命令并归档输入来源、输出与退出码。没有新运行授权时只能运行离线 fixture 对照，并明确真实预检未运行，不能把它填写成已校准。

生产 `npm run build` 结束后、三次实验构建后分别对**同一个** `dist/main.js` 算 SHA-256，要求未被实验构建覆盖。生产 bundle 含 buildTime，跨两次生产重建的 hash 不同不是源码违反冻结；源码冻结使用 git diff 证明。

逐一检查本轮三个 manifest 的源码 SHA、产物字节、实际文件 hash 与新配置来源。manifest 的 PREPARED_NOT_RUN 是构建阶段属性，不手改它冒充运行凭证；实际装载与运行事实在单独证据中记录。

保留旧归档身份；合法配置改变后的新 bundle 不必与旧示例 bundle 逐字节相同。不要为了匹配旧 hash 手改新产物。

### 9.4 冻结核对

至少保存下面三类 diff 的命令、输出和退出码。生产非测试源码对持续基线；本轮不允许修改的实验文件、根配置与 mock 对 BASE。

```bash
run freeze-production git diff --exit-code "$PROD_BASE" HEAD -- src \
  ':(exclude,glob)src/**/*.test.ts' \
  ':(exclude,glob)src/**/*.test.tsx' \
  ':(exclude,glob)src/**/*.test.js' \
  ':(exclude,glob)src/**/*.test.jsx'

run freeze-root git diff --exit-code "$BASE" HEAD -- \
  package.json package-lock.json \
  ':(glob)tsconfig*.json' ':(glob)jest.config.*' ':(glob)rollup.config.*'

run freeze-lab-and-slice git diff --exit-code "$BASE" HEAD -- \
  scripts/build-treasury-terminal-lab.mjs \
  test/lab/terminal-transfer/runIMain.ts \
  test/lab/terminal-transfer/observer.ts \
  test/lab/terminal-transfer/singleShot.ts \
  test/lab/terminal-transfer/controlRecord.ts \
  test/lab/terminal-transfer/worldRead.ts \
  test/lab/terminal-transfer/sample.ts \
  test/mock/treasuryTerminalTransferPrototype.ts \
  test/mock/treasuryTerminalTransferCoordinator.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts
```

检查完整 `git diff --name-status BASE…HEAD`，上述命令未列出的新文件或其他改动仍须符合 §3，不是漏列就允许。记录 `sendGate` 相对 STRICT_BASE 的 diff，解释仅有必要健康检查/说明差异；其他放宽一律不允许。

验证结束再保存 HEAD 与 `git status --short`，确认验证过程没有改源码、测试、配置或预算。

### 9.5 第二干净工作树

同一个 VALIDATION_HEAD，新建干净 worktree，独立 `npm ci`。不得 junction/symlink/复制/共享 `node_modules`；可以共用下载缓存。保存 cwd、Node/npm 版本与依赖实际解析路径。

只需复跑 LAB（含本轮新增工具测试）、Slice 0、三产物构建与核对；不要求再重复全仓压力或预算自跑。本轮实验 JS bundle 应可与主树的同源码产物比较；manifest 生成时间/路径差异不能当成程序字节差异，也不能不比较程序字节。

同一执行者在第二树操作，称“第二环境复现”，不是独立 reviewer 或 CI。第二树不连接游戏、不再发送一笔复验。

## 10. 证据与交付文件

本轮使用新的证据根，不覆盖旧轮：

```text
openspec/changes/empire-treasury-core-rewrite/evidence/
  terminal-transfer-engine-lab-run-i-calibration-rerun/
```

可以沿用 task/environment/offline/engine-run 的组织方式，不要求新证据平台。至少能定位以下材料：

| 材料组 | 必需内容 |
| --- | --- |
| 任务与纠错 | 本任务归档、实际起点与范围、旧错误纠正、旧缺证清单及找回原件来源 |
| 源码身份 | BASE、IMPL_HEAD、VALIDATION_HEAD、DELIVERY_HEAD；修改列表与冻结 diff；最终验证之后的变更性质 |
| 环境 | 授权范围说明、安装原命令/输出、实际 server package/lock、版本/解析路径、启动与 loopback/PID 事实 |
| 基线与预检 | 初始化原快照、真实 runner 原始日志、只读元信息、暂停确认、配置值来源、实际 C02 运行记录 |
| 装载与控制槽 | 本地三 bundle/manifest、活动代码完整回读、解码/hash 核对、武装前后及撤装完整控制槽 |
| 正式实验 | 原 console、逐 tick 派生索引、T 前状态、boundary/返回、后续世界/交易、终态、原始查询 |
| 停止 | 超时/窗口停止触发、暂停/切只读/撤装、进程组退出、监听复核、证据保存与限定清理 |
| 离线验证 | 每条命令/退出码/stdout/stderr、独立 Jest JSON、预算报告、第二树结果、产物身份 |
| 主报告 | C01–C03/S01–S06逐项结果、证据定位、差异与未确认项、实机和离线分列、部署仍禁止 |

不要把完整 `node_modules` 或整个世界目录作为唯一证据交付，也不要只交文字摘要。只保留足够复核当前限定实验的原件。避免将测试源码复制成 evidence 下的新 `*.test.ts`，造成全仓重复收集；测试源码用提交 SHA 定位。

原件含真实密钥时不得提交；本实验本就不应使用真实凭证。必须脱敏的材料说明缺口和处理方式，不伪称脱敏副本与未保存原件 hash 一致。

## 11. 最终验收与 Git 纪律

### 11.1 必须完成的验收

**C01：** 现行源码不再对缺失 shard 放行；异常拒绝与合法对照成立；既有 attempted/4096/main 保护保持。

**C02：** 有真实可执行的独立比较步骤；三项同时错误全部暴露；资料不由 config 生成；无缺失默认健康；没有新配置权威；已在实际绑定/武装前使用，或如实标记因未授权未执行。

**C03：** 现行说明不再保留错误有效结论；旧原件未修改；源 ID 漏诊和旧缺证完整披露。

**S01–S06：** 授权覆盖时按 §8 实际运行与举证。不授权或前置阻塞时，提交已完成离线成果和单一清楚的阻塞说明，不伪造已完成实验。

**回归：** 正式验证 SHA、原始结果、预算、第二树、冻结检查可追溯；无失败、跳测或零收集冒充通过。不得用测试总数替代独立配置验收或实机事实。

### 11.2 提交方式

代码/测试/工具/配置、预算、运行后证据尽量分为清晰的线性提交；不要求为每个小文件单独提交。修正已 push 历史只能新增提交，禁止 reset/rebase/force push/amend 已推送提交。

最终在目标分支 commit 并普通 `git push origin refactor/empire-treasury-rearchitecture`。核对远端实际 SHA 与本地 DELIVERY_HEAD 一致。推送失败就报告本地 SHA、失败命令和未推送状态，不称已推送。

不合并 main，不执行 `npm run push`，不上传游戏正式代码。

### 11.3 最终回复应包含

用中文给出本轮实现摘要、提交链与三种 HEAD、真实测试结果、C01–C03/S01–S06结果及对应证据路径。

单独用普通文字说清：服务是否启动、真实 runner 是否执行、是否曾武装、是否进入 send 边界、调用次数是否可确定、同步返回是什么、是否取得真实100H转运与交易、是否停止并清理。未知就写未知，不能从“没有某行日志”推断零调用。

说明旧轮纠错与新轮实验互不替代；本轮即使 `ENGINE_LAB_PASS`，也只证明当前安装组合与限定正常场景，不自动放行生产国库接入、故障场景或其他经济 writer。

**本轮的完成标准不是把失败报告改成 PASS，而是：严格门禁恢复，配置来自真实且独立的事实，一次受控实验的结果能够被原始材料支持。**

## 12. 依据与阅读定位

下列路径均在本仓库。除特别说明，阅读版本固定为 BASE `bd9570d2c3cf8632202cfee4e3a96d95250add52`。本文中的新增实现要求是本轮整改设计；历史事实以这些文件和原始记录为依据，不把旧报告中的解释当成已证实事实。

| 引用 | 来源 |
| --- | --- |
| R1 | 分支 `refactor/empire-treasury-rearchitecture` 的提交记录；2026-09-09编制时重新读取，HEAD仍为BASE |
| R2 | `test/test-suite-budget.json`；`scripts/verify-jest-budget.mjs` |
| R3 | `openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i/offline/execution-mainval/validation-head.txt` |
| R4 | `test/lab/terminal-transfer/labConfig.ts`、`sendGate.ts`、`worldRead.ts`、`runI.test.ts`；旧严格门禁另读 STRICT_BASE |
| R5 | 旧 evidence 根内 `engine-run/init-snapshot.json`、`console-window.jsonl`、`final-snapshot.json`；后续 shard-probe 须区分user/tick |
| R6 | 旧 evidence 根内 `terminal-transfer-engine-lab-run-i-execution-local-validation.md`；包含执行者报告与本轮须纠正的解释 |
| R7 | `openspec/changes/empire-treasury-core-rewrite/terminal-transfer-engine-lab-run-i.md`、`terminal-transfer-lab-run1-shard-gate-compatibility.md`；旧 evidence 根内 `task/task-brief.md` 的 S01–S06和停止纪律 |
| R8 | `scripts/build-treasury-terminal-lab.mjs`：三模式、唯一源码构建、manifest与文档JSON的实际用途 |
| R9 | `package.json`：`build=rollup -c`；`push/local` 带 DEST 部署目标；不得混用 Git push 与游戏上传 |

本文不是已经完成的运行报告。新配置、新 SHA、新测试数量、API返回、实际交易和停止结果，必须由你在本轮实际完成后填写，不得从本任务的预期描述生成“原始结果”。

---

## 归档说明（执行 Agent 追加，2026-09-09）

本文为对话内附件任务书的逐字归档（编制方原文，含全部章节与引用表）。
实际执行记录见同证据根其余文件与本轮主报告；执行起点核对为本地=远端=
BASE `bd9570d2c3cf8632202cfee4e3a96d95250add52`、工作树干净（§1.2 开工
核对已实际执行）。附件随附的提示语（"The attachment content is
user-provided context…"）为投递通道说明，不属任务书正文，未收录。
