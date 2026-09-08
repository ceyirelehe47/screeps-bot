# Empire Treasury — Terminal Transfer Engine Lab Run I
## 一次性隔离世界：正常 100H 调拨的真实引擎实验

**用途：开发 Agent 完成最小实验接线、离线验证；在取得本轮明确授权后运行真实隔离实验，保存证据、commit、push。本文自包含。**

编制日期：2026-09-08。任务身份：**Terminal Transfer Engine Lab Run I**；验收索引 **S01–S06**。

本轮不是 Lab Prep I · Remediation III，不继续修国库或泛化探针。上一轮 R01–R04 已获限定审查通过。本轮要取得的新增事实只有一个：**由真实 Screeps runner 执行现有 single-shot，经真实 driver／processor 处理一次 A→B 的 100H 请求，并从后续游戏观察核对结果。**

## 0. 必须首先识别的授权变化

此前仅允许离线开发，禁止启动服务器及真实发送。本任务包含这些新动作，因此**编制或仅转发本文件，不自动撤销旧禁止**。

用户明确要求执行本轮隔离真实实验，并认可以下范围后，才执行启动、实验世界写入、代码装载与发送；这一次范围确认后，不必逐命令重复询问。可使用如下授权文字：

> 允许按 Engine Lab Run I，在本机新建、仅本机可访问的一次性 Screeps 实验环境，安装隔离依赖、启动必要服务、创建合成 bot 用户与两个 Terminal、装载实验探针，并最多调用一次发送 100H。允许保存证据后停止并清理本次新建环境。不接入正式服、PTR、既有私服或真实账号，不使用真实凭证，不接入国库生产 writer，不进行第二笔发送或故障注入。

**没有上述范围的明确授权：**可完成源码读取、文档及离线接线，不启动游戏服务，不装载到游戏，不武装。交付 `AUTHORIZATION_REQUIRED`，不能写成实机 PASS，也不要靠继续扩建 Prep 来掩盖授权尚缺。

**已有明确授权但环境能力不足：**尝试被允许的最短安装／启动路径，保存实际失败，交付 `ENV_BLOCKED`。不改用玩家账号、不绕去公共服务器、不安装系统服务或申请付费云资源来完成数字。遇到权限提升、宿主系统改造或新增费用，停止该路径。

## 1. 固定起点与继承状态

| 项目 | 编制时核对值 |
| --- | --- |
| Repository | `ceyirelehe47/screeps-bot` |
| Branch | `refactor/empire-treasury-rearchitecture` |
| 预期起点／上一轮交付 HEAD | `9158c496d77f51072f0899ffa01f60487a031c58` |
| 上一轮最终代码／测试验证 HEAD | `9bf6625503bc8f697fdc2ba1f30e8fb78c58678f` |
| 当前 budget target 锚点 | `ae991e5e73a98ca8de69db0e07b06f71927156c5` |
| 当前 budget target／已归档全仓结果 | **240 suites／1465 tests／1465 passed**；failed、pending、todo、runtime error 均为 0 |
| 上轮定向结果 | LAB 1／22；KEY 9／102；Treasury 35／597；Defense 11／118，集合重叠，不相加 |
| 持续生产冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 当前内核 | `Memory.runtime.treasuryCore`，schema v3，attempt `tk1_`；本轮不装配它 |
| OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |

开始时 fetch 远端。前移则查看增量后沿现有历史继续，不 reset 回表中 SHA，不覆盖他人工作。旧预算的 `baseline.tests=1454` 是历史元数据，本轮起始规模取 **target=1465**。

继承通过，不再重做：Slice 0 的归属、费用、单条在途、部分量保守处理、closing 不双扣；P01 注册 settle 双排列；P02 独立依赖安装；Q 发送前标记确认和结果失败不重发；R 完整 JSON ≤4096 UTF-8 字节的读写／读回约束。

现有实验包：

- `test/lab/terminal-transfer/{labConfig,worldRead,sample,observer,controlRecord,sendGate,singleShot}.ts`
- `test/lab/terminal-transfer/probe.test.ts`
- `scripts/build-treasury-terminal-lab.mjs`
- `openspec/changes/empire-treasury-core-rewrite/terminal-transfer-engine-lab-prep-i.md`

上轮通过的 single-shot 归档：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-prep-i-remediation-ii/final/lab-single-shot/single-shot.js`

其身份为 **27,697 字节**，Git blob `ca78d67204679f6869bc115122fcd8412f6db0d4`，SHA-256 `7730421dd7ef5d453387f03e5ad0eedec5b0b3c9d990bdeda805dd1213811391`。它仍含旧合成配置，**不能不改配置就拿来碰真实实验世界，更不能改已构建 JS 后沿用旧 hash**。

以上都是继承证据，不是本轮实跑结果。先前所有真实引擎实验仍为 NOT_RUN。

## 2. 本轮范围：原始 API 实验，不是国库集成

唯一动作：同一新建合成 bot 用户拥有的 **`W1N57 → W10N57`，100 单位 H**。初始化时源 Terminal 放入 1000H 与 10000 energy，目标放入 0H 与 2000 energy；实际容量、费用、冷却和世界尺寸从运行环境读取。

只进行正常全量场景，不安排第二笔对照发送。两端无 Power 效果、其他搬运者、市场行为或自动生产。控制器满足实际版本的 Terminal 激活条件；不能只把一个看似 Terminal 的数据库对象插进去就认为 fixture 合法。

**本轮成功也只说明所记录安装组合、正常隔离场景中的原始 API 事实。**不宣称国库已经接入真实引擎，不授予正式服部署许可，不证明任意中断下 exactly-once。

### 2.1 允许的最小实现

优先复用现有两份生成物，只补以下必要接线，不强制目录或内部 schema：

| 位置／组件 | 可做什么 |
| --- | --- |
| 实验目录内的薄 `main` 入口 | 在真实用户 runner 中调用现有 observer；仅指定 tick 调用现有 single-shot；把装载版本和窗口信息记录到外部日志 |
| 少量本机实验脚本／CLI 命令文件 | 新目录初始化、合成世界布置、代码装载、收集日志、按已拥有的进程身份停止；默认不自动开服或武装 |
| `labConfig.ts` 与文档示例 | 根据新世界实际读到的实验 ID、用户名、shard、结构 ID、目标 tick、费用上限填写编译配置，并重新提交、构建、验证 |
| 本轮离线接线测试 | 验证实际打包的 main 与 observer／single-shot 连接正确；不会在模块加载、非目标 tick 或窗口外调用 writer |
| OpenSpec、evidence、budget | 记录本轮实际安装、源码、产物、实验过程与结果 |

实现细节由 Agent 决定。能用官方 CLI 和几个明确命令完成，就不建设通用编排器、配置服务、证据平台或新的交易状态机。

**冻结**全部生产源码、类型、内核、facade、主入口与经济装配；Slice 0 adapter／coordinator；现有 controlRecord 的字节约束及 singleShot 的标记顺序；observer 的只读性质；根 package.json、package-lock.json、TypeScript／Rollup／Jest 配置、Seal 工具和 Defense 生产代码。游戏服务器依赖必须安装在独立实验目录，不能混进 bot 根依赖。

新发现与本任务无关的建议单列，不顺手重构。若真实 API 兼容性导致已有探针不能执行，提交可复现事实并标记阻断；不能悄悄替换 Game API、修改引擎处理函数或自造交易记录让实验通过。

## 3. 运行环境：版本真实、状态全新、出口受限

### 3.1 首选安装路线与版本说明

首选官方 `screeps` standalone server，以及它的 backend／storage／engine／driver 组合。用官方 NPC bot 管理接口运行新建的实验用户，避免把 Steam 登录或真实玩家账户引入实验。**Node VM 假 Game、直接调用 processor 导出函数、xxscreeps 或第三方重写引擎不能替代本轮实机结果。**

本次查到的官方聚合包源码 `package.json` 声明 `screeps=4.3.0`，依赖 `@screeps/engine=4.3.0`、`@screeps/driver=5.3.0`、`@screeps/backend=3.3.0`、`@screeps/launcher=4.2.0`，Node 要求 `>=22.9.0`、npm `>=10.8.2`。[E1]

此前参考源则为：

- engine `80977824199a596d174d392fd0cf8c458c21fcbd`，其 package.json 标为 **4.3.2**；
- driver `cf63d8adf902663e2ebddd7f8c5b7baa425dc928`，其 package.json 标为 **5.3.0**。[E2][E3]

**这不是同一套已验证安装组合。**为尽快取得真实事实，本轮可优先使用官方 `screeps@4.3.0` 的完整依赖组合，不强行拼装参考 SHA。实施前查明公开包实际存在及完整依赖，安装并生成独立 lockfile；若实际版本与候选不同，如实记录原因和实际版本，不把它写成此前参考 SHA。不能自动使用 `latest` 或原地 upgrade。

记录 Node/npm、OS/架构、服务器包及各模块版本、实际解析路径、独立 lockfile／包 integrity，以及真正加载的 Terminal API、发送处理器和 driver 相关文件 hash。不能只记录目录顶层 package.json，而实际进程从另一套 node_modules 加载。来源 SHA 不可取得时记录可核验包版本与文件身份，不编造 commit。

官方仓库的源码参考与实际安装包必须分开。关键版本差异只需一张短表；不要为本轮补建整个版本兼容平台。

### 3.2 安全启动边界

在已授权前提下，创建新的实验根目录和独立数据文件。可使用现有可用的容器／等效隔离环境；也可用独立本机进程，但须明确监听和访问边界。**不为本轮自动安装 Docker、数据库服务、系统守护程序或改宿主防火墙。**

必须做到：

- HTTP、CLI、storage 全部只允许本机或本次专用内部网络访问；容器不向公网发布端口。不要沿用 stock launcher 的 HTTP `0.0.0.0` 默认值。[E4]
- 不加载 bot 仓库 `.secret.json`、既有 `.screepsrc`、PTR 配置、现有数据库、玩家 Memory 或真实登录凭证。新实验 bot 不通过真实玩家账号登录。
- 新建数据目录、日志目录和进程身份可辨认；发现旧世界／端口占用／身份不明即拒绝复用，不执行 `resetAllData()` 清空它。
- 启动时使用明确环境，清除可能覆盖目标的 `DRIVER_MODULE`、`STORAGE_*`、`GAME_*`、`CLI_*`、`MODFILE`、`DB_PATH` 等继承配置；保留运行所需的普通环境即可。不要只信配置文件，因为参考 launcher 会合并父进程环境。[E5]
- 安装阶段可访问公开依赖来源；运行阶段只使用本地服务，不连接 MMO／PTR／现有私服，不设置真实 Steam key。空 key 的 CLI／NPC 路径如不兼容，记录 ENV_BLOCKED，不索取真实凭证绕过。

先核对**实际安装版本**的命令帮助及初始化代码。官方提供 `screeps init/start/cli`、NPC bot 和管理 CLI，但本文件不是某一主机已实测的启动脚本。可在新目录安装精确版本后使用以下命令族，参数按实际帮助核对并把最终命令归档：[E4–E7]

```text
npm install --save-exact screeps@4.3.0      # 只在独立实验目录；非 bot 仓库根
<该安装的 screeps 可执行文件> init
<该安装的 screeps 可执行文件> start --host 127.0.0.1 --cli_host 127.0.0.1 ...
<该安装的 screeps 可执行文件> cli ...
```

不要粘贴省略号运行，也不要把上述模板填入“已经运行”的证据。初始化如提示 Steam key，先确认该版本允许无玩家认证的本机 CLI／NPC 使用；不得填入真实 key 或下载玩家数据。默认 LokiJS 存储已可提供独立世界，不要求为两间房再引入 MongoDB／Redis。[E4][E6]

默认只需一个 runner、一个 processor。关闭不需要的自动 bot／mods；不禁用或改写经济处理语义。保存所有本次进程 PID／所属容器或进程组，异常退出应停止整组，不能只杀 worker 后让 launcher 自动拉起。

为避免模拟停滞留下无人管理的服务，启动前固定本机停止措施：实机恢复运行后的墙钟看门限值 **180秒**，以及T+20的观察终点，任一到达即停止本轮推进并保存已取得事实；前者是操作保护限值，不是完成时间估计。不把无限等待或服务常驻作为交付。安装阶段与世界暂停期间的离线验证不计入该实验运行限值；这些阶段退出也须清理本次进程。

## 4. 执行顺序：先观察，暂停固定，再单次发送

### 4.1 建立与核验合成世界

通过已确认的本地管理入口暂停模拟；等待当前在途 tick 完成，重复读取 tick／世界状态确认已经静止。**pause 返回 OK 不等于此前 worker 必然瞬间停止。**参考 backend 的 pause/resume 是设置模拟暂停状态，没有原子单步保证。[E7]

在确认属于本次新世界后创建两个指定房间及一个合成 NPC bot。为它提供仅只读的初始代码，再布置两端合法控制器和 Terminal，设置 §2 的初始库存。管理层初始化数据库是允许的 fixture 布置，但必须标清“管理员初始化”，不能计为玩家经济动作。

官方 NPC 入口支持 `bots.spawn`／`bots.reload`。当前 backend 源码使用 `opts.username`，聚合 README 示例写法未必与安装版本一致，必须核对实际接口，不凭记忆硬编码。[E4][E8]

生成的结构 ID 和用户名必须回读；明确目标房间对 bot 可见、两端 `my`／owner 与激活条件成立。确认无运输 creep、第二个工作 bot、其他经济脚本、Power、待处理 terminal intent 或市场订单。先归档初始化完成快照，然后**停止一切会修改两端经济状态的 fixture 布置**。

### 4.2 只读基线与采样通道

先让真实 runner 连续执行 observer，取得至少两个不同 tick 的稳定基线：两端资源、energy、总容量／空位、cooldown、交易视图和真实 tick。额外的只读元信息可由薄 main 输出实际 shard、world size、控制器等级和活跃状态。

捕获的是**游戏用户 console 输出的真实通道**以及相关 server 日志。不要只保存 launcher stdout，却遗漏 driver 发布的用户日志。根据实际安装的 driver/backend 的 console 通道装配外部收集器，先证明确实收到该 bot 的样本。[E9]

读取失败、房间不可见或视图不是数组，按原探针语义保留错误，不补成零或空数组。基线已有完整关联描述相同的记录则停止；不要删除交易历史来整理出“干净”结果。

### 4.3 暂停并固定正式实验配置

只读基线成立后再次暂停并等待稳定，记录暂停时的实际 tick `T0`。**不要修改游戏时间或恢复旧数据库来凑目标 tick。**

用已读回的真实实验身份填入编译配置；保留固定路线、H、100 和32样本上限。选择暂停点之后的目标 tick `T`，建议 `T0+3`；每次运行使用一个明确的新实验 ID／完整关联描述；本次描述使用可区分实验的短ASCII文本，并满足实际API的100字符上限。[E10] 费用上限从实际 `calcTransactionCost(100,A,B)` 取得并与源 energy 比较，可直接将本次上限固定为读到的 `q`，不硬编码 fake 的26。

把本轮薄接线、配置及测试提交，固定新的 `VALIDATION_HEAD`，在世界保持暂停时离线验证并重建。复制到 bot module 目录时保持 observer／single-shot 原始产物字节，分别保存 hash；任何包装入口也先提交、记录 hash。代码装载回读核对模块字节／内容身份，不把“CLI 命令无异常”当成代码已经装好。

`labConfig.ts` 仍是编译配置来源；JSON 只是同步文档。Memory只写受支持的控制字段，不能将整份实验配置塞入控制槽。配置改变后必须重新构建，不编辑已生成 JS。

### 4.4 让两个已有入口在同一个真实 runner 中正确协作

本轮必须解决一个接线事实：single-shot 在发送后不会自行持续输出后续世界样本，**不能只装载它然后等待不存在的后续记录**。

使用最薄的 `main`：在有限窗口内每 tick 调 observer；仅 `Game.time===T` 时调一次已有 single-shot。建议先 observer 后 single-shot，以保留调用 tick 的前态；single-shot 自带的 pre-call／boundary／sync-return继续原样输出。窗口可固定为 **T−2 到 T+20**，共23个 tick，低于既有32样本上限。窗口外不调用 single-shot，错过T不续期。

main 不直接调用 `terminal.send`，不自行初始化／重置控制槽，不复制 attempted、费用或归属判断，也不引入国库。observer 单独产物仍然保持零发送、零 Memory 写。

先对**实际装载的 main + 两个生成模块**做离线测试：模块加载无动作；目标 tick 前后零 writer 调用；目标 tick 确实调用 single-shot；T+1及后续仍产生观察；正常场景总 spy=1；无武装场景总 spy=0；窗口结束不再采样／发送。离线测试只是接线验证，不能算真实引擎结果。

### 4.5 单次武装、恢复运行与观察

服务器仍暂停且装载身份核对完成后，通过本次本地管理入口写入合法小控制记录：匹配实验 ID、`armed=true`、`attempted=false`，不附加未知字段。回读记录并确认完整 JSON ≤4096 UTF-8 字节。写入只允许针对本次合成 bot。

在外部日志记下武装和代码身份后恢复模拟。现有 single-shot 负责发送前 attempted 写入／读回确认；**不得用管理员直接调用 send 或写 transaction 表替代它**。

完成以下观察：

1. T 的调用前世界、真实同步返回码／异常和控制事实。
2. 每个后续 tick 的两端资源、energy、空位、cooldown、incoming/outgoing 原始记录；记录实际首次可见 tick，不预设一定T+1。
3. 到 T+20 的有限窗口末端，至少保留结果出现后的两个连续观察及是否出现第二次调用的事实。

处理可能比预期慢；不能跳到很晚只取终态并声称逐 tick 观察。观察丢失、日志截断、没有到达目标 tick、返回非OK或没有可解释结果，都如实失败／不确定，不修改限值、不清掉 attempted 重试、不再发第二笔。

窗口结束立即暂停并转只读／撤销武装，保留 attempted 和结果事实。若出现重复调用、非预期用户／路线、预算外变化、日志收集失败或其他经济 writer，立即停止运行并取证，不继续尝试“修到成功”。

## 5. 实验判读：预期不是证据

用实际 T 前样本定义源 `H_A0`、源 `E_A0`、目标 `H_B0`、目标 `E_B0`、目标空位 `F0`；用实际API报价定义 `q`。管理员初始化的数字不能代替玩家视图基线。

在本轮没有其他经济变化的正常场景中，预期如下：[E10][E11]

| 观察项 | 正常全量预期 | 如何取证 |
| --- | --- | --- |
| 同步返回 | 实际返回 OK；它只代表提交已调度 | 保存原始 sync-return，不把它单独当最终完成 |
| 源 H | `H_A0−100` | 后续玩家视图与只读原始世界记录对照 |
| 目标 H | `H_B0+100` | 同上 |
| 源 energy | `E_A0−q` | 实际 delta 与本次报价对照，不强填26 |
| 目标 energy | 正常无其他动作时保持 `E_B0` | 读取实际值；不一致即解释或标差异 |
| 目标空位 | `F0−100` | 使用真实 store 容量接口，不照抄 mock 的100000 |
| cooldown | 按实际版本记录发送后及后续变化 | 不要求看到某个预写的10；读取安装常量和逐tick读数 |
| 交易归属 | 关联描述、双方、路线、资源、实际amount与当前实验一致 | 保留两视图完整原记录及实际字段，不只保存筛选后结果 |

交易观察要区分**游戏交易ID**与实验ID。incoming/outgoing 中同ID可为同一笔的两个视图，不能累加为两次100H；同ID内容矛盾或多个不同ID都关联本实验时，不任选一条成功记录。两视图可见性如与预期不同，保留原始事实与版本说明，不能注入镜像补齐。

至少联合核对调用记录、库存／费用变化和真实交易记录，不用“只有库存变化”或“有一行OK”宣告整个实验通过。窗口内没有记录不证明未执行。不能用 lastQuote／mock matcher 或国库结算工具代替真实证据判读。

**仍不测：**目标只能容纳60、故意制造即时ERR、CPU终止、driver保存不一致、global reset故障、自动重试、部分结算、国库接线。正常样本即使通过，也不能覆盖这些待测项。

## 6. S01–S06 与交付状态

| 索引 | 完成标准 |
| --- | --- |
| **S01：授权／隔离／版本** | 有本轮明确运行授权；新世界／新用户／新存储；监听与进程身份清楚；实际 engine／driver／依赖版本及来源可核验，无真实凭证或现有世界复用 |
| **S02：真实只读基线** | 真实 runner 的 observer 产生连续不同tick的有效样本；两端合法可见，无其他经济writer；原始日志通道实测可用 |
| **S03：固定代码的单次调用** | 暂停后固定配置与已验证源码，装载字节可追溯；既有 single-shot 在指定tick走真实API；调用前attempted成立，总调用边界不超过一次 |
| **S04：后续真实结果** | 完整窗口中实际取得库存／费用／容量／冷却／交易记录；正常100H关系可核对，镜像不双计；不确定或差异如实保留 |
| **S05：停止与无污染** | 有限窗口结束，停止本次完整进程组／容器；保留证据后只清理本次新建目录／世界；不反向发送“归还”资源，不影响既有服务；生产冻结保持 |
| **S06：可审查交付** | 命令／日志／安装lock／源码SHA／装载模块hash／实验前后快照／判读表齐全；测试与真实引擎结果分列；线性commit/push，非自报PASS替代原始产物 |

最终只能据事实使用以下状态：

- **ENGINE_LAB_PASS**：S01–S06成立，当前安装组合的正常100H真实实验通过。
- **ENGINE_LAB_INCONCLUSIVE**：进入了实验，但关键事实不完整／结果不能确定。保留attempted，不重试。
- **ENGINE_LAB_MISMATCH**：正常场景产生非预期返回、金额、归属或调用次数等可复核差异。
- **ENV_BLOCKED / AUTHORIZATION_REQUIRED**：实机前置未具备；真实实验为NOT_RUN，不和离线PASS混写。

测试模型的PASS、服务器启动成功、只有runner日志、只有processor函数单测，均不能升级为 ENGINE_LAB_PASS。只观察到正常完成，也不能升级为生产部署通过。

## 7. 验证、证据与提交纪律

### 7.1 离线验证保持聚焦

先提交所有实际接线代码、测试、运行驱动和编译配置，更新真实budget，再固定 `VALIDATION_HEAD`。原测试不删断言、不调宽上限。以下命令在bot仓库执行；与实验服务器目录严格分开，`unset DEST`，不调用生产上传脚本。

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.build.json
npm run build
npx jest --config jest.config.cjs --runInBand --runTestsByPath test/lab/terminal-transfer/probe.test.ts
# 新main／本机运行保护的离线测试，加入实际路径，不能漏跑或零收集。
npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts
npx jest --config jest.config.cjs src/runtime/treasury/ --runInBand
npx jest --config jest.config.cjs --runInBand
node scripts/verify-jest-budget.mjs
git diff --check
```

Defense固定回归集继续包含：`defenseFocusFire`、`defenseFocusFireStateful`、`defenseFallbackReallocation`、`defenseAllActorReservation`、`defenseGlobalRampartFootprints`、`defensePreallocationRampartOwnership`、`defenseStationaryRampartOwnership`、`homeDefense`、`towerControl` 的 `src/runtime/*.test.ts`，`src/roles/homeDefender.test.ts`，`test/memoryDeclarationBoundaries.test.ts`。用真实路径运行并记录结果，不以零匹配代替回归。

各Jest命令加 `--json --outputFile=<独立输出文件>`，保存 stdout/stderr、退出码和完整命令。输出目录用新建临时目录，不删除自己的日志。长测试只按既有要求运行；不用第二工作树再次重复全仓压力。

冻结核对：生产非测试源码相对 `869149d…` 零差异；根依赖与构建配置零差异；Slice 0两个test/mock实现相对起点零差异；现有probe保护逻辑除必要接线不得变。生产bundle与实验bundle分开存放，禁止把实验文件输出覆盖 `dist/main.js`。

同一固定SHA的第二干净工作树独立 `npm ci`，不共享node_modules；复跑LAB、新main离线测试和Slice 0即可，保存原始结果及解析路径。**reviewer独立审查本轮真实证据，不再发送一笔“复验”。**无法独立执行时如实标注，不把同一人换目录称独立审查。

### 7.2 实机证据最小集合

证据根建议：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i/`

保存 `task/`、`offline/`、`environment/`、`engine-run/`、`review/` 与一份短报告即可，不新建证据schema平台。必须能回答：

| 类别 | 至少保留 |
| --- | --- |
| 授权与环境 | 授权范围／来源、新建根目录、端口和进程身份、实际版本／解析路径／lockfile、启动与暂停命令结果 |
| 固定代码 | VALIDATION_HEAD、编译配置、main及两个生成模块、manifest、SHA-256、装载回读身份；旧PREPARED manifest不篡改成已执行 |
| 世界与调用 | 初始化后快照、只读基线、T前控制记录、原始用户console／服务器日志、调用tick和同步结果、后续逐tick样本及最终控制记录 |
| 结果判读 | 以实际基线计算的资源／费用／容量差值、交易ID及镜像关系、实际首次可见tick、异常／缺样清单 |
| 停止与复验 | 最后观察tick、切只读／暂停、完整进程组退出与数据范围清理记录、reviewer核对结论及原始离线复跑输出 |

实验的db/env只读导出须遵循实际存储的暂停／刷盘方式；不要在worker写入时直接复制db.json后宣称原子快照。权限、认证字段不进入报告。新世界虽为合成数据，也不归档操作系统环境变量全集或npm认证配置。

原始JSON/log保留，不只交手写“成功”。结论表可以人工编写，但每行对应原始路径、tick与具体交易事实。真实世界状态不得由Node测试fixture生成，禁止用生成的理想数据替换缺失样本。

### 7.3 Git与退出

不reset已推送历史、不rebase、不force push、不amend已推送commit、不合并main。按接线／配置与测试、预算、证据边界线性提交。真实实验使用固定已验证版本；其后只追加证据与说明。若必须改源码／测试／配置，应承认原运行对应旧版本；**进入过发送后不得在本轮直接再跑第二笔**。

推送 `refactor/empire-treasury-rearchitecture` 并核对远端HEAD。记录代码验证HEAD与最终交付HEAD，检查src/test/scripts及配置的验证后差异；取得 `git status --short`、`git log --oneline --decorate -40`、status/check-runs/Actions，有结果才称CI。

停止时只操作本次记录的进程组、容器和新建数据目录。先保存日志与必要快照，再销毁一次性世界。不能对共享Docker资源全局prune，不能对已有库reset，不能递归清理身份不确定的路径。停止失败必须显式报告仍存活的进程，不写成已清理。

**本轮终点是“一笔正常100H的原始API真实实验及其可审查结论”，不是接管经济系统。运行通过后停止，不自动部署国库、不扩到市场／其他writer、不启动下一组故障实验。**

## 附录：事实来源与阅读定位

下列链接是编制时实际核对的资料；公开源码参考不能代替本轮安装和运行证据。master链接仅供定位，实施时记录实际安装版本／文件身份。

- **[E0] 项目起点**：`9158c496d77f51072f0899ffa01f60487a031c58` 的 budget、上轮 `final/validation-head.txt` 和 `terminal-transfer-engine-lab-prep-i.md`；起点值见§1。
- **[E1] 官方服务器聚合包**：https://github.com/screeps/screeps/blob/master/package.json — 编制时读取到4.3.0、精确模块依赖和Node/npm要求；不宣称已成功安装。
- **[E2] 既有engine参考**：https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/package.json — 参考源码标4.3.2，区别于[E1]依赖的4.3.0。
- **[E3] 既有driver参考**：https://github.com/screeps/driver/blob/cf63d8adf902663e2ebddd7f8c5b7baa425dc928/package.json — 标5.3.0；同版本号不独立证明npm包与该SHA全部字节相同。
- **[E4] 官方standalone说明**：https://github.com/screeps/screeps — CLI启动、默认LokiJS存储、监听参数、模块职责和NPC bot；stock HTTP默认监听不是本轮允许边界。
- **[E5] launcher进程与环境接线**：https://github.com/screeps/launcher/blob/master/lib/start.js — 进程环境合并、模块解析与自动重启；须在实际安装版本重核。
- **[E6] 初始化入口**：https://github.com/screeps/launcher/blob/master/lib/init.js — 创建世界目录和Steam key提示。未持有本轮凭证授权，不得用真实key填充。
- **[E7] 模拟暂停与恢复**：https://github.com/screeps/backend-local/blob/master/lib/cli/system.js — pauseSimulation／resumeSimulation／tick duration；不存在本文已验证的原子单步假设。
- **[E8] NPC创建与代码重载**：https://github.com/screeps/backend-local/blob/master/lib/cli/bots.js — spawn、reload及用户／代码／Memory初始化；只针对本次新实验用户。
- **[E9] driver日志与运行定位**：https://github.com/screeps/driver/blob/cf63d8adf902663e2ebddd7f8c5b7baa425dc928/lib/index.js — 定位sendConsoleMessages等真实日志通道；按安装实现核对，不预设launcher stdout包含全部用户日志。
- **[E10] 官方API**：https://docs.screeps.com/api/#StructureTerminal.send 及 https://docs.screeps.com/api/#Game.market — 发送返回、费用、incoming/outgoing视图；仅作为预期依据。
- **[E11] 官方game loop**：https://docs.screeps.com/game-loop.html — 玩家脚本指令与后续世界更新的边界；不将本轮无故障观察升级成持久化原子性证明。
