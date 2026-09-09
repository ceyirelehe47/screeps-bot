# Terminal Transfer Engine Lab Run I · Control Remediation I
## 实现任务书：Memory 控制通路、预检完整性、及时停止与一次受控复验

编制日期：2026-09-09。对象：负责 `ceyirelehe47/screeps-bot` 的开发 Agent。

**本轮目标：修复三个已经被具体证据定位的实验控制问题，在授权覆盖时，完成一次新的本机隔离 100H 实验。不是重写 Treasury，不是再次恢复 shard 门禁，也不是扩建通用实验平台。**

本文是下一轮实现任务，不是运行结果或额外授权。你需要实际修改、测试、保存原始证据、线性 commit 并 push。下文明确区分“继承的事实”“本轮新增要求”和“真实运行后才能填写的结果”。内部数据布局沿现有代码设计，不另定一套 schema。

---

## 0. 范围、授权与唯一完成目标

### 0.1 允许的任务

本轮只处理：

- **R01：Memory 控制通路。** 管理侧写入必须到达真实玩家运行时；先在无发送路径的准备阶段证明往返，再启用正式发送代码。
- **R02：现有 C02 预检。** 修复必需字段/交易视图漏检、样本排序、基线稳定性及暂停点之后的窗口可达性判断。
- **R03：外部停止。** 正式窗口结束或 180 秒墙钟上限，先到者触发停止；异常也须及时停止，不能依赖几十秒一次的人工检查。
- 纠正现行状态说明，保留旧轮失败原件；按 S01–S06 安排一次有界的新实验。

**所有实现以跑通这条有限链路为准：真实控制记录可见 → 正确预检 → 一次真实 API 调用 → 后续世界观察 → 及时停止。** 不增加库存统计、资源均衡、生产接入、市场、战斗或其他业务。

### 0.2 授权边界

之前的执行会话据归档已得到“授权执行 S01–S06”，并实际运行了上一轮。不得再说用户从未授权过本机实验；但该已结束实验的授权，不自动变成永久重跑许可。[S3]

你应先读取自己执行会话中的真实用户指令：已明确覆盖本轮同等范围时，直接按范围执行，不逐命令询问；尚未覆盖这个新实验时，只做一次范围确认。没有覆盖时完成离线修复、验证、提交，实机写为 `AUTHORIZATION_REQUIRED`，不得伪造新世界事实。本文自身不代替用户授权。

本轮运行范围必须同时包括：新建本机一次性世界、合成用户与两端设施；只读准备与限定控制槽写入/往返检查；**最多一次真实 `terminal.send(100H)` 调用**；取证和停止清理。未授权的部分不能从已授权的部分推导出来。

### 0.3 游戏业务边界不变

| 项目 | 固定要求 |
| --- | --- |
| 路线 | `W1N57 → W10N57`，同一新建合成用户 |
| 资源与数量 | `H`，100；不是动态选择资源/路线/数量 |
| 运行环境 | 新目录、新世界、新实验身份，仅本机 loopback；不复用已清理旧世界 |
| 正式入口 | 复用既有 `runIMain`、`observer`、`singleShot` |
| 正式观察窗口 | `T−2 .. T+20`，23 tick；现有 `maxSamples=32` 不扩大 |
| 正式停止边界 | 窗口完成或 180 秒墙钟上限，先到停止；危险/证据通路异常可提前停止 |
| 尝试次数 | 最多一次调用，不是最多一次成功；非 OK、异常、不确定均不再发 |
| 其他禁止 | 无正式服/PTR/既有私服/真实账号/真实凭证；无国库生产 writer、市场、生产、反向归还或故障注入 |

只读准备中的 stub 调用不是实机发送；管理员初始化库存不是玩家转运；准备阶段观察到 Memory 也不构成数据库式 exactly-once 或 driver 故障恢复证明。

---

## 1. 起点、继承成果与已核对版本

### 1.1 本轮预期基线

| 角色 | 值 |
| --- | --- |
| 仓库 | `ceyirelehe47/screeps-bot` |
| 分支 | `refactor/empire-treasury-rearchitecture` |
| 本轮预期 BASE / 编制时最新远端 | `d69726a92d46c3ab334355a6625ef253c1523a86` |
| 上轮实机绑定与代码验证 HEAD | `7b9135985ab3ce02192c853f051e76005562866e` |
| 当前预算 baseline/target 锚点 | `13511d8dd95fc6044fe597b5a019c4a84699882a` |
| 当前预算及归档全仓结果 | 242 suites / 1486 tests / 1486 passed；failed/pending/todo 均为 0 |
| 持续生产非测试源码冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 当前 OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |

上述 HEAD、预算与验证锚点在本任务编制时已重新读取。[S1][S2] 测试数字是继承结果，不是本轮预写的验收数字，也不是独立 CI 结果。各定向集合重叠，不能相加。

开工先执行并留档：

```bash
git status --short
git fetch origin refactor/empire-treasury-rearchitecture
git rev-parse HEAD
git rev-parse origin/refactor/empire-treasury-rearchitecture
git log --oneline --decorate -12
```

工作区不干净不得删除未知修改。远端前移时，先看与预期 BASE 的差异和已有修复，避免重复实施；可保持本任务边界的线性增量应如实记录实际起点。出现业务/权限边界变化则暂停实机部分，交付已经完成的离线结果与冲突说明。禁止 reset 已推送历史或直接以旧 SHA 覆盖新代码。

### 1.2 保留而不重做的成果

**严格 shard 门禁已经修好。** 缺失/null/非法 name/读取异常拒绝，不再有 sentinel 放行；本轮冻结 `sendGate.ts`，不能为了实验成功回退保护。[S4]

继续冻结：Treasury Core、facade、生产主入口、全部生产经济装配和 Defense；Slice 0 两个 mock 与三个测试；现有 main 的 observer 单向依赖；single-shot 的指定 tick、发送前 attempted 写入/读回、4096 UTF-8 字节边界与发送后不恢复许可的规则。

原始 Terminal API 实验仍没有接入国库生产内核。其正常结果即使通过，也不自动解除生产部署、国库真实业务接入或其他故障场景的限制。

---

## 2. 上轮事实与本轮修复依据

### 2.1 实机直接阻断：控制记录没有进入玩家运行时

上轮实验为 `lab-run1-cal-0002`，T0=198、T=201，窗口199..221。T201 原始 console 为 `lab-precondition-rejection / no_control_record`，没有进入 send 边界。终态记录同时包含：

- 管理侧用户记录的 `memory` 字段中，有 `armed=true, attempted=false` 的实验记录；
- `envMemory="{}"`；两端库存不变，交易数为0。

这些原件支持“错误写入通路导致运行时未见控制记录”，不支持“运行时已有效武装”。不能用数据库某字段写入/读回成功代替游戏运行时读取成功。[S3][S5]

上次审查读到的上游 driver 代码从 `env.get(env.keys.MEMORY + userId)` 取玩家 Memory；它支持排查方向，但**不是本轮实际安装包的字节证明**。R01 必须核对安装版本的真实读写通路，再实现最小操作。不要把 `db.users.memory` 当成一个未经核对的集合名，也不武断泛化该字段在所有版本中的用途。

### 2.2 预检有七类已复现漏检

上轮独立审查使用 BASE 的原始 `calibrationCheck.ts`、`labConfig.ts` 和归档真实 facts，文件 Git blob 身份分别为：

```text
calibrationCheck.ts             0c55cb9e3dff294fccb884a61c6b14e66c02025d
labConfig.ts                    357543a08e7ab899c73339f5b94f91ceb2379f50
s02-calibration-facts.json       acfbb51894d268d288480ddc2e9a1c8ad4411a9f
```

正常 facts 返回35/35；但删除全部 outgoing、删除最新双方向视图、暂停点改为200而T仍201、前后源H不稳定、早期报价不可读但保留数值、最新目标H/energy缺失、反序排列掩盖最新缺货，均可错误返回35/35。完整复现要求见 R02。

**这些是独立复制输入上的人为反例，不是声称上一轮真实基线发生过这些变异。** 本次实机失败直接原因仍是 `no_control_record`；不能将两个问题混为一个。

### 2.3 最终停止不等于及时停止

原始 T221 样本接收时刻是 `09:17:43.107Z`，世界最终停于T254。180秒兜底日志记录 `09:20:13.152Z` 触发；报告说明主流程采用45秒轮询。最终进程组终止及端口检查有原件支持，但窗口末端多推进33 tick，不能把 S05 无条件标成完成。[S6]

### 2.4 现行说明要纠正，历史原件不改

本轮新增简短纠正记录，说明：C01保留；C02不能仅靠35项全绿验收；“曾武装”拆为管理写入与运行时有效武装；最终停止与及时停止分别评价。上轮 `ENGINE_LAB_INCONCLUSIVE` 保留。

不要原位重写上一轮主报告、console、快照、测试JSON、工具归档或bundle。新轮事实不能补造旧原件，也不需要重新开展旧环境考古。

---

## 3. 修改白名单与工程边界

| 位置 | 允许的修改 |
| --- | --- |
| `test/lab/terminal-transfer/calibrationCheck.ts` | 修复现有比较逻辑，不新建配置权威 |
| `test/lab/terminal-transfer/calibration.test.ts` 及相关fixture | 独立反例/合法对照；旧真实原件保持不变，变异用副本 |
| `scripts/verify-lab-calibration.mjs` | 必需输入诊断、退出码与来源记录；仍只读，不连游戏 |
| `test/lab/terminal-transfer/tools/` 等本实验专用工具路径 | 最小控制写入/只读探查/外部停止及针对性测试；记录最终实际路径 |
| `labConfig.ts`、`example.experiment.json` | 新实验身份与最终T/q绑定，或未运行状态的准确说明 |
| `probe.test.ts`、`runI.test.ts` | 仅必要的配置身份迁移；原保护断言不能削弱；无需重做接线 |
| `scripts/verify-jest-budget.mjs`、`test/test-suite-budget.json` | 按真实测试结果更新数值、说明和存在的提交锚点；不改核验规则 |
| 当前 `terminal-transfer-engine-lab-run-i.md`、`tasks.md` | 更新现行状态、指向新证据及纠正说明 |
| 本轮新证据目录 | 任务、纠正、命令、结果与原件 |

额外只读探查入口优先使用一个独立、很小的实验文件，不引入新的运行时控制协议。确有复用构建器的必要时，允许 `scripts/build-treasury-terminal-lab.mjs` **仅增加一个显式只读探查入口的构建支持**：原三种模式、默认observer、无上传/无生产配置加载/输出目录保护均不变；同一配置下原三产物不得受该扩展影响。该差异必须单列并测试，不借机重构构建器。

禁止修改 `sendGate.ts`、`controlRecord.ts`、`worldRead.ts`、`sample.ts`、`observer.ts`、`singleShot.ts`、`runIMain.ts`、整个 `src/`、两个 Slice mock 以及根 package/lock/tsconfig/Jest/rollup配置。禁止增加生产依赖、Memory根、健康token、自动重试、新清理状态机或宽松的备用写入口。

**工具源码也算实现代码。** 复制旧管理工具时，在新的工作路径中修改并先提交；旧 evidence/tools 原件冻结。实际使用的管理、采样、停止、事实提取与结果判读脚本必须有可追溯的已提交版本，不能运行临时修过的脚本，再在最终证据提交中补称它经过此前验证。

---

## 4. R01 — 证明真实 Memory 往返，而不是重复数据库自证

### 4.1 实现真实读写通路

在独立 server 安装中，核对用户 Memory 的加载来源、允许的管理写入入口和tick结束后的保存路径。记录实际包版本、解析路径及最小相关源码片段；不修改 engine/driver/backend 逻辑，不开展超出本问题的引擎研究。

如果该安装组合确实使用 `env.keys.MEMORY + userId`，管理工具应操作这一已核实通路，或调用语义等价且已核实的官方本地入口。**不采用“写很多位置总有一个会生效”的办法，不把密码/认证设置命令当作 Memory 接口。**

工具必须显式绑定本轮合成userId、本机服务与本轮新建环境；不能读取真实账号配置，不能接受继承环境变量将地址改到线上。写入前等待模拟暂停且在途tick已结束，避免玩家tick保存覆盖管理员修改。

只操作已有 `__labTerminalTransferProbe` 控制槽。完整读取当前玩家 Memory，保留其他字段；解析失败则停止，不覆盖成 `{}`。已有控制记录与预期阶段冲突、attempted已为true或实验ID不同，则拒绝，不清除记录继续。槽的合法形状与4096字节规则复用既有语义，不增加额外授权字段。整个Memory与控制槽的字节量要分别记录，不能混用。

发送后的撤装也走同一个已核实的运行时通路，保留attempted和结果事实。不得再次只修改上轮那种不参与运行时加载的字段。

### 4.2 只读控制探查

准备入口的源码调用图中没有 send，没有自动武装、重置或控制槽写入，也不能 require 正式 single-shot。用fake端口验证装载与执行均零send、零Memory写。直接输出实际读取到的控制槽及读取状态，并携带真实tick和合成用户来源；不能打印期望配置冒充读数。

至少保留两层证据：

1. 管理写入请求及从**运行时使用的存储通路**得到的原始回读；
2. 同一个合成bot在两个不同真实tick输出的实际控制记录，及随后暂停后的存储回读。

缺失或无法解析要明确输出错误。用户console通道、userId、实际记录中的experimentId必须相互对应；旁边另一个bot读到记录不能代替本bot成功。

### 4.3 准备顺序调整：先证实武装可见，再固定正式T

这是本轮针对已知错误作出的流程调整，不改变 single-shot 协议：

```text
只读入口活动，正式send不可达
→ 初始化/写入同一实验的 armed=false、attempted=false
→ 两个真实tick读到，暂停并核对保存值
→ 一次写入 armed=true（须运行授权）
→ 仍由只读入口运行，两个真实tick读到 true/false 与同一实验ID
→ 暂停，确认稳定T0
→ 此时才首次绑定最终T ≥ T0+3
→ 固定配置与验证源码、构建并装载正式三模块
→ 同一已确认控制记录不重置，正式窗口最多一次send
```

这样，运行时武装确认不会消耗掉已经固定的发送窗口。**准备阶段不宣布正式T已经绑定；最终绑定后不得移动T，更不能在拒绝后改T补发。** 只读采样使用已经固定的实验身份和路线，T在此阶段尚未生效，不靠修改Memory覆盖编译配置。

这不是两次真实实验或两次send授权：只有一个实验ID、一次false→true武装、一个最终T和最多一次send。准备阶段的false记录只用于验证控制通路，不是新的持久状态类型。

每个真实只读往返阶段最多等待180秒并限制采样数量，取得所需两个不同tick即可暂停；失败则停止、保存原件，不无限轮询。武装记录不可见、被覆盖、出现attempted或来源不匹配时，**不要装载正式发送入口，不得反复清槽/重新武装到成功**。未武装时允许修复准备工具并重新进行有界只读校验，但每次修改和观察必须保留，代码重新提交验证；不得伪装成同一个未变化的准备过程。

### 4.4 R01离线验收

| 场景 | 必须结果 |
| --- | --- |
| db用户字段有记录，但运行时Memory来源为空 | 判为未就绪；不能宣布武装成功，不启用发送入口 |
| 实际通路写入失败、读回不同、玩家脚本仍读不到 | 明确阻断；无备用位置写入、无自动清槽 |
| 玩家读到错误实验ID、错误user来源或attempted=true | 阻断；原记录保留 |
| 原Memory带其他字段 | 合法更新只改变目标槽，其余值保持 |
| 完整合法正例 | false记录往返，再一次true记录往返；不会因保护而把所有输入都拒绝 |
| 只读探查实际产物 | 装载/两个tick运行均零send、零脚本Memory写；输出来自输入世界的记录，不是期望常量 |

离线测试可以模拟两个存储位置不同；只能证明工具行为，不能替代本轮真实runner往返。不能将同tick对象回读包装成driver已落盘或跨崩溃原子性保证。

---

## 5. R02 — 修复 C02 的完整性、排序、稳定性和时间判断

### 5.1 保持现有结构，修正确认条件

继续使用 `checkLabCalibration(config, facts)` 和现有CLI。`labConfig.ts`仍为唯一编译配置来源；独立facts仍由真实采样产生，预检报告不写回游戏、不授予新权限。

需要落实以下语义：

**样本按真实tick解释。** tick必须是合法非负安全整数；至少两个不同tick。可对输入副本排序，不改变原facts或文件；最新样本是最大tick，不是数组尾。重复tick本轮一律报告不合格，避免冲突副本被静默选择或重复计数。保留输入次序信息供定位，不按接收墙钟替代游戏时间。

**每个基线样本都必须完整。** 每个样本的incoming、outgoing分别存在，status为ok且records为数组。缺少一个方向、缺最新样本、读取失败，均不能用其他方向或较早记录补足。现有同description检查保持完整字符串相等，出现冲突即拒绝；不复制生产matcher，不注入镜像。

两端readStatus、terminalId、owner、my/isActive、控制器合法性及资源读数逐样本核对。两端的H、energy、总空位、cooldown均需实际存在、类型合法、为非负有限整数；H=0是合法数值，缺失不是0。源H≥100、energy≥固定cap、目标空位≥100、源cooldown=0等条件仍需成立。读取异常或不适用的容量不能变成健康。

**稳定性不是“最新一次够用”。** 当前实验刻意使用无其他相关经济writer的静止基线；被提交为稳定基线的所有样本，两端身份、H/energy/空位/cooldown和健康状态必须一致。前一tick源H=0、后一tick1000，不属于本次合格稳定基线。尚在初始化的真实读数保留原件，初始化结束后另取明确标记的新基线，不从失败输入中偷偷删掉不合意样本。

**报价每次都必须真正可读。** 每个样本status=ok、q为非负有限整数，全部一致。早期status=unavailable而数值留存26，不得仅按值相同放行。本实验绑定规则继续为cap=q；正式sendGate仍独立检查实时q≤固定cap，不自动调大预算。worldSize仅诊断，不升级成授权条件。

**时间以最后稳定暂停点为准。** 基线必须晚于最后fixture/map等会影响世界事实的管理修改；暂停确认T0允许晚于最后玩家样本tick，不强求相等。正式绑定满足：

```text
max(基线样本tick) ≤ T0
T ≥ T0 + 3
```

这确保暂停点之后仍可取得T−2样本。T/T0也需合法安全整数，计算不能溢出。不能再用`T≥maxSampleTick+3 && T>T0`冒充该要求。最终控制往返后的暂停点才是绑定用T0，不能沿用更早暂停点。

代码reload本身与fixture修改分开记录；不能伪造管理修改时间让样本显得新鲜。真实活动模块身份、控制往返、外部停止就绪各自验证，C02“通过”不包办这些职责。

### 5.2 必须重现的反例与合法对照

使用BASE归档的真实facts副本，不根据待验config反向制造世界。复现旧实现错误返回，随后让新实现拒绝同一输入。源码身份与每个变异点记录清楚。

| 索引 | 输入/变异 | 新实现预期 |
| --- | --- | --- |
| P01 | 原完整健康facts，匹配配置 | pass；逐项来源可追溯 |
| P02 | 删除所有样本outgoing | fail/missing，指出每个缺口 |
| P03 | 仅删除最新样本两方向视图 | fail/missing；不能借早期视图通过 |
| P04 | 较早样本q状态unavailable、数值仍26 | fail；最新样本正常不能覆盖读取失败 |
| P05 | 最新目标H、energy字段缺失；另做null/非有限值 | fail；显式0合法对照仍能通过 |
| P06 | 较早源H=0、最新=1000 | fail：不稳定；两次同为1000且其余正常通过 |
| P07 | 实际最新tick源H不足，然后将数组反序 | 两种排列都fail；完整健康数据两种排列结果一致且不改输入 |
| P08 | T=201，样本196/197，T0=200 | fail；T0=199也fail；T0=198为合法对照 |
| P09 | 重复tick、矛盾同tick、非法tick | fail；两个不同合法tick不误拒 |
| P10 | shard、源ID、cap三项同时不匹配 | 一次列全，不因首项失败漏掉其他项 |
| P11 | 所有视图完整，但含当前完整description记录 | fail；其他无关description不误拒 |
| P12 | 使用非26报价，例如q=37 | cap37健康通过，cap36/38按cap=q绑定规则拒绝；不修改配置上限 |

追加少量覆盖源/目标资源稳定性和必需健康字段的参数化变体即可，不做无穷排列。新结果不要求继续恰好35项；以实际规则覆盖为准。

CLI必须实际运行健康/不匹配/坏输入三个路径，分别产生正确退出状态和可读诊断；保留当前0/1/2退出码约定。输入非法时不能静默成功，也不只输出一个无法定位缺口的TypeError。能独立评估的差异尽量一次报告；不要靠将不完整输入裁剪成健康输入消除异常。

独立审查附件中的“断言旧错误输入仍pass”是锁定缺陷用的诊断，不是新的正确验收要求。不要原样复制成鼓励漏检的正式测试。

---

## 6. R03 — 真正执行“窗口结束/180秒先到停止”

### 6.1 外部控制，不改正式main

由一个小型外部流程同时管理两种停止条件。可以订阅现有真实console/完成事件；若需要轮询，则使用已固定的短间隔，不依赖人工每45秒查询。接入现有收集通道即可，不建设消息总线或新监控平台。

正式恢复模拟前，必须确认外部流程已连接、日志可写、拥有本轮进程组身份、暂停入口可用；“就绪”只是一项外部操作检查，不写成游戏Memory健康token。

墙钟截止点在正式恢复运行请求之前固定，使用不因系统时间校正倒退的计时方式；从开始等待恢复起就计时，不能等连接结束后才额外给180秒，也不能通过重连/重启watcher续期。截止点在观察链断开时仍必须有效。

窗口条件采用**本轮同一用户、同一实验的有效T+20末端样本**，或具有等价已完成语义并核实过的引擎事件。不能把pubsub中的`tickStarted="1"`当游戏tick，也不能在T+20刚开始、observer尚未执行时提前宣称窗口完成。缺少应有样本、解析失败或错过窗口则按不完整处理并停止，不能为凑齐样本延长上限。

### 6.2 触发时延与暂停确认分开

本轮新增验收要求：外部流程观察到有效窗口结束条件或墙钟截止条件后，**1秒内发起第一次暂停请求**。采用轮询时，固定轮询间隔不大于250毫秒；订阅方式不要求额外轮询。离线用受控时钟验证，实机保存接收/截止、请求发出时刻及实际延迟。

暂停请求发出不等于世界瞬间原子停止：允许已经在处理的tick收尾，但要保存暂停响应、重复只读稳定核对和最终tick。不要要求“最终tick必须精确等于T+20”，也不能把几十秒延迟归为正常在途tick。

暂停调用异常、返回失败或5秒内无法确认稳定暂停时，启动已记录的本轮完整进程组终止兜底，并立即取证；不能继续等另一个180秒周期。窗口已触发时更不能忽略它直到墙钟兜底。若外部调度阻塞导致1秒要求没有达到，原样记为及时停止未达标，即使最终库存正确也不能完整验收PASS。

事件监听器重复收到终态、窗口和deadline同时发生，不应反复破坏性操作或重开模拟；一个幂等stop流程即可。停止失败不能吞异常后退出0。只终止本轮创建并核对的进程树/容器，禁止全局杀node或清理其他服务。

### 6.3 R03离线验收

| 场景 | 必须结果 |
| --- | --- |
| 先收到本实验T+20有效样本 | 1秒内请求暂停，不等180秒 |
| 一直没有末端样本 | 到180秒截止及时请求停止，不续期；窗口不完整 |
| 其他bot/其他实验/伪tick或不合法样本 | 不能当本轮正常完成；按来源与健康规则处理，deadline不失效 |
| 事件重复、两个停止条件同时满足 | 不恢复模拟；停止动作幂等且原因可追溯 |
| 暂停抛错、挂起或未稳定 | 有界走本轮进程组兜底；明确报告暂停失败 |
| 收集器断开/退出、必要数据解析失败 | 实验不能继续被标为健康；及时停止，不再启用或重启发送 |
| 尚未到停止点的健康流 | 不误停T前正常窗口；末端样本确实被保存再收尾 |

必须测试实际停止控制逻辑，而不是只断言“设置了一个timer”。使用fake clock、fake pause和fake进程组端口，离线不得连接任何游戏服务或终止真实进程。

---

## 7. 实施顺序与成本控制

先阅读BASE的checker、CLI、控制槽reader、正式main和上轮最小原件，再实施R01–R03。不重新研究全部玩家代码，不重跑已完成的国库设计论证。

建议按以下顺序一次收口：

1. 离线复现R02旧错误，修复比较函数及测试；实现最小Memory工具/只读探查与外部stop，做各自正反例。
2. 将实际工具、入口、测试及文档作为实现提交固定；更新真实预算。未获新运行授权时，完成本轮离线验证和明确阻塞交付。
3. 获授权后，在新世界完成无send路径的控制往返与稳定基线；只读准备阶段使用已经提交的工具，修改工具必须重新固定与跑受影响验证。
4. 最后暂停点确定后，一次性绑定新实验最终配置T/q/IDs，提交必要配置及测试迁移；固定最终 `VALIDATION_HEAD`，执行§9正式验证。
5. 世界保持暂停；装载最终产物、核对控制记录仍在、启动停止保护，执行一个正式窗口；运行后仅追加原始证据与准确报告。

不要求每个小准备文件单独一轮任务，也不要求每次只读排错都重跑全仓压力；但**最终实际运行代码、测试、配置和所有驱动必须有完整、有效的正式验证**。准备件版本和正式件版本不同要明确列出，不能把后改工具塞进已有验证SHA的声明中。

本轮最多一个正式窗口。正式恢复前的准备失败可以交付阻塞而不是凑一次运行；正式恢复后即使send=0，也不得在同一任务中换实验ID/T/世界再试。不要以“次数未消耗”为无限续跑理由。

---

## 8. S01–S06：新的受控实机步骤与结果判读

### S01 — 授权、安装和隔离

使用新建本机目录与独立server package/lock，不复用旧环境，不修改bot根依赖。上轮记录的版本组合为screeps4.3.0、engine4.3.0、driver5.3.0；它们只是安装复核参考，不代替新安装结果。保存实际版本、解析路径、server package/lock原件、安装退出码，以及绑定loopback的进程/端口记录。

禁止真实凭证和真实账号登录。启动前清除会覆盖连接目标的变量并核实实际endpoint；端口已被未知服务使用则停止，不杀原服务。记录新建进程组/目录所有权，才能做后续限定清理。

### S02 — 无send准备、控制往返与稳定世界

完成地图、房间、fixture和必要缓存初始化后停止管理侧世界变更。两个Terminal须合法、同主、可见、active，具备足够H、费用能源和目标空间。可沿用源1000H/10000E、目标0H/2000E的fixture，但实际玩家视图才是基线，不从初始化参数反造样本。

只装载R01的无send只读入口，证明用户日志收流。按§4.3完成false记录往返和一次true记录往返，期间顺带读取两端健康事实和实际报价。基线最少两个不同真实tick，全部相关世界读数稳定；无其他经济writer影响本实验两端。默认世界其他NPC存在不等于本实验必定无效，但不能据此宣称全世界没有其他bot。

取得往返后暂停并确认实际稳定T0，保存最后两次及必要原始上下文；不得丢掉更早的失败或初始化样本。新的shard、user、结构ID、q都重新读取，不照抄Forst、aa17545…或26。worldSize只记录诊断。

### S03 — 最终绑定、验证、装载、单次正式运行

实验ID应为新的短ASCII身份，完整description可精确关联且满足当前API限制；不含真实敏感信息。最终 `labConfig.ts` 固定新身份、结构、路线、H100、q对应的cap、T≥T0+3；JSON示例同步但不成为运行时配置。

运行修复后的C02实际CLI，保存独立facts、配置源码身份、报告及退出码。配置/测试/实际驱动提交后固定 `VALIDATION_HEAD`，世界保持暂停，完成§9正式验证与构建。不能手改生成JS、替换Game或编造transaction来通过。

装载三模块后，从实际活动分支完整回读代码，逐模块核对UTF-8字节和SHA-256。重新读取运行时控制存储，确认之前玩家已经读到的同一条 `armed=true, attempted=false` 记录仍在；reload不能顺手清Memory、重新初始化attempted或覆盖成新实验。暂停点和两端世界读数未变化，最终T仍可达；有变化则不得靠陈旧C02标签放行。

正式窗口前，确保外部停止与收集通路就绪，固定180秒deadline，再恢复模拟。只有既有main在T调用既有single-shot；发送前attempted确认由原实现完成。管理员不得直接调用send替代玩家代码。

### S04 — 原始调用与后续观察

完整记录T−2..T+20每个玩家样本、T调用前态、发送边界及真实同步返回/异常、后续库存/能量/容量/cooldown和交易视图。按实际首次出现结果的tick报告，不预设一定T+1。

正常无其他动作场景，用实际调用前读数与实际q核对：

| 事实 | 正常全量预期 |
| --- | --- |
| API | 一次真实调用；同步OK只是已安排，不单独代表最终交付 |
| 源H / 目标H | 分别变化−100 / +100 |
| 源energy / 目标energy | 分别变化−q / 0 |
| 目标空位 | 变化−100；源空位变化也按真实Store读数核对 |
| cooldown | 保留实际安装组合逐tick结果，不硬填10 |
| 交易 | 实验完整description、双方、路线、资源、amount及时间关系对应同一请求 |

两视图同交易ID的镜像不能双计。多个不同ID都关联本请求、同ID内容矛盾、数量不符、缺视图或结果不可解释，原样保留差异；不能任选成功一条、补镜像或删数据。至少联合核对调用、世界变化与真实交易，不以单独OK或库存差值判整体通过。

记录数量不等于覆盖完整：逐tick索引须检查缺口/重复/截断及用户来源。只有缺日志不能判send=0；实际gate前置拒绝配合执行代码及世界证据支持时，才写确定零调用。

### S05 — 及时停止、撤装、终态、进程退出

按R03先到者立即请求暂停；保留末端样本/截止时刻、实际触发、请求、响应、稳定tick与延迟。到deadline未完成窗口就结束，不延长观察以凑通过。

暂停稳定后保存两端世界、完整相关交易原始查询、运行时控制Memory。通过正确通路撤装，保留attempted/结果；保存撤装前后原始值。如果只能取得管理侧运行时存储回读，称“存储侧撤装已回读”，不能冒充又取得了一条玩家执行证明。无需为撤装证明重开正式窗口。

停止本轮收集器和完整server进程组，确认相关PID退出与loopback端口无监听。只有证据可读且已复制保存后，才清理本轮新建目录内容；不反向send归还，不全局prune，不删除未知目录。不确定停止成功时优先处置风险并如实报告，不为保留漂亮窗口继续运行。

### S06 — 分层结论

| 状态 | 条件 |
| --- | --- |
| `ENGINE_LAB_PASS` | R01–R03及S01–S06均有足够事实；一次正常100H、完整观察、正确停止、来源可追溯 |
| `ENGINE_LAB_INCONCLUSIVE` | 正式窗口已开始但被门禁阻断、结果缺失/不可定、证据不完整，或无法整体验收；不补发 |
| `ENGINE_LAB_MISMATCH` | 实际调用/返回/资源/归属/次数出现可复核的非预期差异 |
| `ENV_BLOCKED` | 环境、控制往返、预检或停止准备不满足，正式发送窗口未开始；已做的服务/只读活动逐项列出 |
| `AUTHORIZATION_REQUIRED` | 新运行缺覆盖；离线成果与实机未运行分列 |

已经有正常转运证据、但及时停止不达标时，单列“转运事实有支持，完整实验验收未通过”，不得合成为PASS。不要把整轮失败等同于所有离线修复无效，也不要把部分通过等同于已经完成实验。

---

## 9. 验证、预算与冻结核对

### 9.1 先固定实际代码，再正式验证

全部测试和实际管理/采样/停止/判读工具先入实现提交。预算引用必须是已存在、含实际测试文件集的提交；先产生实现SHA，再更新预算锚点与真实计数，不写不存在的未来SHA，不要求提交自引用。

保留现有预算核验器规则、保护文件、无skip/only/todo/failing检查。新增测试多少以实际收集为准，不为沿用1486删测试，也不靠直接降低预算过关。

正式输出到仓库外新临时目录，防止验证期间源码树变脏。每条命令留完整调用、开始/结束、stdout/stderr、退出码；Jest另存原始JSON。Windows使用等价命令时记录实际执行形式，不照抄他人日志。以下Bash示例可直接用作记录骨架：

```bash
set -euo pipefail
unset DEST
BASE=d69726a92d46c3ab334355a6625ef253c1523a86
PROD_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
E="$(mktemp -d "${TMPDIR:-/tmp}/screeps-lab-control-r1.XXXXXX")"
printf '%s\n' "$E"
run() {
  local label="$1" rc
  shift
  {
    printf 'cwd: %s\ncommand:' "$PWD"
    printf ' %q' "$@"; printf '\n'
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
test ! -s "$E/status-before.txt"
run npm-ci npm ci
run typecheck-all npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run production-build npm run build
```

先断言HEAD就是计划的最终VALIDATION_HEAD。普通命令失败保留原件并停止放行；预期失败的反例命令用显式退出码断言处理，禁止`|| true`统一吞错。`npm run build`前不设置DEST，不运行`npm run push/local/watch`；Git push不等于游戏上传。

### 9.2 正式回归集合

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
  src/runtime/treasury/ --json --outputFile="$E/jest-treasury.json"

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

新增工具测试若在LAB路径之外，单列实际路径加入定向回归。检查真实非零收集、无失败/pending/todo/运行错误；不能以“full应该会跑到”替代该工具的具体测试结果。第二树不再重复全仓压力/budget。

实际运行修复后的CLI健康/不匹配/坏输入及本轮真实facts预检，保存完整报告与退出码。没有真实facts就标记未运行，不将离线fixture称为新世界已校准。

### 9.3 构建与冻结

```bash
run build-observer node scripts/build-treasury-terminal-lab.mjs \
  --out "$E/lab-observer"
run build-single-shot node scripts/build-treasury-terminal-lab.mjs \
  --mode single-shot --out "$E/lab-single-shot"
run build-main node scripts/build-treasury-terminal-lab.mjs \
  --mode run-i-main --out "$E/lab-run-i-main"

run freeze-src git diff --exit-code "$BASE" HEAD -- src
run freeze-production git diff --exit-code "$PROD_BASE" HEAD -- src \
  ':(exclude,glob)src/**/*.test.ts' ':(exclude,glob)src/**/*.test.tsx' \
  ':(exclude,glob)src/**/*.test.js' ':(exclude,glob)src/**/*.test.jsx'
run freeze-root git diff --exit-code "$BASE" HEAD -- \
  package.json package-lock.json \
  ':(glob)tsconfig*.json' ':(glob)jest.config.*' ':(glob)rollup.config.*'
run freeze-runtime-lab git diff --exit-code "$BASE" HEAD -- \
  test/lab/terminal-transfer/sendGate.ts \
  test/lab/terminal-transfer/controlRecord.ts \
  test/lab/terminal-transfer/worldRead.ts \
  test/lab/terminal-transfer/sample.ts \
  test/lab/terminal-transfer/observer.ts \
  test/lab/terminal-transfer/singleShot.ts \
  test/lab/terminal-transfer/runIMain.ts \
  test/mock/treasuryTerminalTransferPrototype.ts \
  test/mock/treasuryTerminalTransferCoordinator.ts
run freeze-old-evidence git diff --exit-code "$BASE" HEAD -- \
  openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i \
  openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i-calibration-rerun
run diff-check git diff --check
```

若实际BASE前移，变量改为开工记录的实际起点，原预期BASE对照仍保留。完整`git diff --name-status BASE HEAD`另存，未列入冻结命令不代表允许改。

生产构建结束后，对同一个`dist/main.js`在实验/只读产物构建前后计算hash，证明未被覆盖。生产bundle含buildTime，跨不同生产构建的hash不作源码冻结判据。当前实验产物合法新配置不能沿用历史hash，须记录新manifest、字节和实际装载回读；manifest构建态不手改成运行证明。

只读探查产物也保存实际构建命令和身份并测试；构建器若扩展，单列diff与“同配置下原三模式不变”的对照。最终验证结束再次保存HEAD/status，确认没有修改被验证的内容。

### 9.4 第二环境与后续变更

在同一VALIDATION_HEAD新建干净worktree，独立`npm ci`；不复制/共享/junction/symlink `node_modules`，允许共用下载缓存。只复跑LAB、新工具测试、Slice0和产物身份比较，保存真实路径与解析来源。不能再发一笔“独立复验”。

同一执行者换工作树称“第二环境复现”，不是独立reviewer或CI。最终验证后若更改任何实际运行源码、测试、配置或工具，原验证不覆盖改动；重新固定SHA，至少重跑受影响验证、产物和完整性检查，涉及最终正式基线则保证完整验证仍成立。运行后交付提交应只增加事实原件和说明。

---

## 10. 证据、验收和交付

本轮新证据根：

```text
openspec/changes/empire-treasury-core-rewrite/evidence/
  terminal-transfer-engine-lab-run-i-control-remediation-i/
```

沿用task/offline/environment/engine-run和一份主报告即可，不造证据平台。需要能直接定位：

| 组别 | 必需内容 |
| --- | --- |
| 来源/版本 | 任务归档、BASE/实现/最终验证/交付SHA、预算真实数值、全部工具版本及冻结diff |
| 离线反例 | 旧checker同输入错误结果、新实现正确拒绝、合法对照；Memory/stop实际逻辑测试及CLI输出 |
| 环境 | 实际授权范围、server安装package/lock原件、版本/解析、创建的PID/目录、loopback检查 |
| 控制往返 | 安装代码读写通路定位；false及true管理写/回读、同用户玩家两tick原始输出、暂停后存储值 |
| 配置/代码 | 独立世界样本、最后暂停点、新配置来源、真实C02输入/报告、最终bundle/manifest、活动模块完整回读 |
| 正式运行 | 原console、逐tick索引、boundary/返回、库存/费用/容量/cd、完整相关交易、最终控制记录 |
| 停止/清理 | watcher就绪/截止、末端样本、触发/请求/确认/稳定tick及延迟；兜底实际是否使用；撤装、PID/端口、限定清理 |
| 主报告 | R01–R03、S01–S06逐项状态与证据定位；失败/未知/未运行不伪装成通过 |

原日志保留，解码/筛选/统计是派生文件并写明来源。不要复制`*.test.ts`到evidence触发重复收集；源码通过提交SHA引用。也不必把整个node_modules或世界目录作为唯一证据。敏感原件不得入库，使用合成账号并说明任何必要脱敏与身份限制。

### 10.1 本轮验收要回答的问题

**R01：** 是否用正确通路让同一bot在无send阶段真实读到false、再一次true记录？若仅离线实现，明确真实往返未取得。正式装载是否保持同一记录而无重置？

**R02：** 七类已知漏检是否真正被拒绝？排序、完整性、稳定性和T0公式是否有合法对照？报告是否仅作预检而未变成新授权？

**R03：** 实际停止条件是否先到触发？有无“及时请求”和“最终停止”各自的证据，是否超时/兜底失败？

**S01–S06：** 是否确有授权、完整环境与身份、最多一次调用、真实后续世界、及时停止与完整原件？不满足则具体记录，不以离线绿测替代。

### 10.2 Git与最终回复

清晰分开实现/预算/最终绑定/运行后证据，但不为每个小文件制造一个阶段。禁止reset/rebase/force push/amend已push历史；普通线性commit后推送本分支，不合并main、不游戏部署。

```bash
git push origin HEAD:refactor/empire-treasury-rearchitecture
git ls-remote origin refs/heads/refactor/empire-treasury-rearchitecture
```

核对远端SHA与交付HEAD一致；推送失败如实报告本地SHA和失败记录。

最终中文回复必须分别说明：服务是否启动、只读runner是否执行；管理侧控制值写入与玩家实际读到是否各自成立；正式窗口是否开始、send次数是否可确定、同步返回、100H世界变化和交易是否成立；及时停止、最终停止、撤装与清理是否各自有证据。附真实测试、各HEAD、R/S结果与最重要原件路径。

**到这里结束本轮。即使PASS，也不继续扩展国库、接入生产writer或开启下一笔实验。下一步是否进入真实国库业务接入，由本轮独立审查之后另行决定。**

---

## 11. 依据与阅读定位

以下均为本仓库资料；除明确说明，固定阅读版本为BASE `d69726a92d46c3ab334355a6625ef253c1523a86`。路径中的 `OLD` 在本表内指 `openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i-calibration-rerun/`，仅为阅读缩写，不是需要创建的目录。

| 引用 | 来源及用途 |
| --- | --- |
| S1 | 编制时分支提交记录；`test/test-suite-budget.json`、`scripts/verify-jest-budget.mjs`：当前起点和预算 |
| S2 | `OLD/offline/round2-validation/validation-head.txt`、`jest-full.json`：最终代码验证SHA与归档结果 |
| S3 | `OLD/terminal-transfer-engine-lab-run-i-calibration-rerun-offline-validation.md`，尤其§8；`OLD/engine-run/README.md`：执行者报告，部分结论须收窄 |
| S4 | `test/lab/terminal-transfer/sendGate.ts`、`controlRecord.ts`、`singleShot.ts`、`runIMain.ts`；`OLD/corrections.md`：继承保护与已落实纠错 |
| S5 | `OLD/engine-run/s03-arming-write.txt`、`s03-arming-readback.txt`、`s05-final-state.txt`、`s02-console-baseline.jsonl`：实际no_control_record与存储读数不同；该JSONL同时含准备及正式窗口 |
| S6 | `OLD/engine-run/tools/stop-guard.cjs`、`s04-stop-guard.log`、`s04-mid-window-check.txt`、`s05-taskkill.txt`、`s05-stop-verify.txt`：窗口停止缺口及最终停止原件 |
| S7 | `test/lab/terminal-transfer/calibrationCheck.ts`、`calibration.test.ts`、`scripts/verify-lab-calibration.mjs`、`OLD/engine-run/s02-calibration-facts.json`：预检实现与真实基线 |
| S8 | 审查附件 `screeps-calibration-rerun-review-probes-2026-09-09.zip`：独立函数级反例；附件不可访问时按§5表在仓库同SHA源码/facts副本上重建，不影响实现 |
| S9 | `OLD/task/task-brief-calibration-rerun.md`、当前 `terminal-transfer-engine-lab-run-i.md`：继承S01–S06业务边界；本轮准备顺序和及时停止量化要求以本文为准 |

本文中的阶段顺序、完整性修复、1秒触发/有界暂停兜底等是本轮新增实现要求，不是上轮已经取得的运行事实。真实的新ID、T、q、测试数量、返回码、交易与停止延迟，必须由本轮实际执行产生。
