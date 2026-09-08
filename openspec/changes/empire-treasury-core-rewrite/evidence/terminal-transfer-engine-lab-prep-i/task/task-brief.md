# Empire Treasury — Terminal Transfer Engine Lab Prep I
## Slice 0 交接复验与隔离引擎探针包（仅构建与离线自测）

**用途：开发 Agent 直接实施、测试、commit、push。本文自包含，不需要读取聊天历史。**

编制日期：2026-09-08。状态：**待执行任务书，不是验收报告，也不授权启动服务器或真实经济调用。**

任务身份：**Terminal Transfer Engine Lab Prep I**；验收索引 **P01–P06**。承接 Slice 0 · Remediation II 的 O01–O06。**不是 Remediation III，不重写国库，不扩展调拨业务范围。**

> 本轮结束离线原型的两项交接保留，新增一个能实际构建、能离线验证、默认只读的引擎实验包。它用于下一阶段区分"API 接受请求"与"真实世界效果、Memory 和交易记录如何留存"。本轮不执行真实引擎实验。交付不能只有一份"将来怎么做"的计划，但也不能把假端口自测包装成真实引擎通过。

## 1. 起点、阶段结论与冻结范围

| 项目 | 编制时重新核对的值 |
| --- | --- |
| Repository | `ceyirelehe47/screeps-bot` |
| Branch | `refactor/empire-treasury-rearchitecture` |
| 预期起点／上一轮交付 HEAD | `a03cac5f9735d3a63980c681a07ed3a9a13d978e` |
| 上一轮最终代码／测试验证 HEAD | `fc5edf3bfa057cba254a0d6b4be4109b445f2d37` |
| 上一轮实现／预算引用锚点 | `2099e564bd52ef0908e34b338c16c2a0717fa199` |
| 持续生产冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 当前预算／已提交全仓结果 | **239 suites／1440 tests／1440 passed**；failed、pending、todo、runtime error 为 0 |
| 上轮定向结果 | Slice 0 三文件 3／20；Treasury 35／594；KEY 8／77；Defense 11／118，集合有重叠，不累加 |
| 当前内核 | `Memory.runtime.treasuryCore`，schema v3，attempt `tk1_` |
| OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |

上述计数来自 Agent 已提交的运行证据，不是本文编写方独立重跑结果。实施前 fetch 并核对远端；前移时检查增量、沿现有历史继续，不 reset 回上述 SHA、不覆盖他人工作。[R1–R3]

**继承限定通过：**相关交易先归集、再判唯一、最后判全量；固定 `W1N57 → W10N57` 路线；普通及两种配对恢复链路的 closing 不双扣。已有完整归属、冻结费用、单条在途、延迟处理、unknown 保留和 cleanup 继续保留。本轮不要求再证明这些实现"原来有漏洞"。

**只剩两项交接保留：**O01 的两种记录排列没有全部走注册 settle 入口；第二工作树通过 junction 共享了依赖安装。它们是测试覆盖与环境复现问题，不预设生产内核有缺陷。[R4–R6]

核心上限保持：active 64、recent ring 128、核心 JSON 字符预算 360,000、生命周期 8 份/tick、外部释放成对预扣 2 份且至多 4 次/tick、每记录至多 8 个消费者和 12 条 worstCase 腿、现有 fresh 限额。不扩容、不放宽 validator、不延长保留期。

## 2. 本轮交付物与权限边界

交付物只有三组：**一组小型集成补验；一个与生产完全隔离的 Terminal 原始 API 探针包及本地构建入口；一份包含版本、运行步骤和待测矩阵的实验交接说明。**

建议位置如下；内部函数、类型和文件拆分由实施者决定，不固定新 schema。

| 位置 | 允许内容 |
| --- | --- |
| `src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts` | 补齐注册入口的顺序用例，保留原断言 |
| `test/mock/treasuryTerminalTransferPrototype.ts` | 仅在确有需要时提供测试视图的排序装配；优先在用例中 spy/包装现有只读视图，不改 matcher 语义 |
| `test/lab/terminal-transfer/` | 新增独立探针源码、两个构建入口、合成示例配置、离线测试，全部排除于生产入口之外 |
| `scripts/build-treasury-terminal-lab.mjs` | 只进行本地编译和产物清单输出，无连接、上传或启动服务器能力 |
| OpenSpec／本轮 evidence | 本文副本、简短交接说明、原始验证产物 |
| 现有预算 manifest／预算脚本 | 仅更新真实测试收集与锚点元数据 |

**禁止修改**生产 kernel、facade、actionContracts、coverage、observation、生产 testHarness、主运行入口与装配；禁止修改根 `package.json`、lockfile、生产构建／TypeScript／Jest 配置及 Defense 生产代码。当前工程已具备 TypeScript、Rollup、Jest 与 Screeps 类型，优先复用现有依赖。[R7]

实验代码不得导入 `src/main.ts`、完整经济调度器、部署插件或其他 writer；不得把大段生产逻辑搬入实验目录规避冻结。`scripts/verify-treasury-evidence.mjs`、通用 reset harness、Seal 核验 helper 默认零修改。

**本轮绝不执行：**`npm run push`、`npm run local`、游戏服务器启动、容器/数据库启动、游戏代码上传、真实 `terminal.send()`／市场交易，以及 CPU 超限或 driver 故障注入。不得读取或复制 `.secret.json`、正式账户、PTR、现有私服、玩家 Memory、token 或连接配置。允许按现有 lockfile 安装开发依赖；允许只读取得公开固定版本源码，不安装或启动游戏服务。

## 3. 工作 A：一次补齐 Slice 0 交接，不再扩展原型

### 3.1 注册 settle 入口下的两种真实排列

沿现有协调器 → contract → 真许可 → fake 延迟处理，先正常完成一次100H。随后通过现有交易视图注入**同完整描述、路线、双方、资源、合法时窗，但另一游戏交易 ID 的60H记录**。

必须让注册 `service.settleUnknownOutcome({attemptId})` 实际读到 `[100,60]` 与 `[60,100]` 两种排列。不是只反转一个注入数组，而真实100始终被宿主放在数组最前面；也不是仅调用 `adapter.reconcile()`。

最小做法：在用例中读取公开视图后，使用 spy/包装器返回其独立副本及反序副本。**只改变排序，不改变交易集合、身份、数量、时点、来源或世界状态。**记录并断言 adapter 实际得到的 ID/amount 顺序。保留同视图及跨 outgoing/incoming 的组合；不建设通用乱序平台。

两种排列都要断言：settle=`still_uncertain`，同 attempt 仍在 active、phase=`outcome_unknown`、outcome=`unknown`，提交数不增加。使用独立正常场景证明唯一100H仍 committed → closing → cleanup退出，closing投影保持900H、10000−q energy、F0−100空位。已有同ID冲突、无关60H和仅部分量对照保持。

这项新增覆盖可以直接在当前实现上通过，不要求先把生产或原型改坏来制造红灯。若实际发现顺序缺陷，先保存最小集成反例，只在现有测试专用 adapter 中作最小修复；不解冻内核。

### 3.2 第二工作树真正独立安装依赖

在本轮新的 `VALIDATION_HEAD` 上建立干净 detached worktree，使用该树自己的 `node_modules` 和 Jest cache，执行 `npm ci --no-audit --no-fund` 并保存完整安装输出、退出码、Node/npm版本和 lockfile hash。

**不能使用 junction、symlink、目录映射、共享 node_modules 或完整复制另一树的已安装 node_modules。**允许复用 npm 下载缓存；下载缓存与共享模块安装是两回事。记录 `node_modules` 的实际路径，核对关键依赖解析确实落在第二树。

第二树复跑本轮探针测试、Slice 0 M/N/O、既有KEY和Defense；不要求第二树再跑全部长压力。reviewer必须读取本任务全文，并独立检查§3.1实际返回的记录顺序，而非只抄主报告。

没有独立reviewer时，如实写"同一执行者第二树复现"；安装失败写 `ENV_BLOCKED`，保存实际失败，不偷偷退回junction并声称独立环境完成。可以继续交付其余结果，但P02不能算通过。

## 4. 工作 B：默认只读的真实 API 探针包

### 4.1 它测什么，不承担什么

**这是引擎契约的原始 API 对照探针，不是另一套国库，也不是已经把国库接到真实引擎。**后续先用它确认真实时序、交易字段和持久化组合，再决定如何将当前冻结 adapter 接入。探针不复制国库的授权、重试、清理、对账权威或 retired/range 机制。

实验包必须有可构建源码和可执行的离线测试。不能只交README、空函数、打印"PASS"的脚本或另一份fake的成功摘要。

本轮实现的两个独立入口：

| 构建产物 | 语义 |
| --- | --- |
| `observer` | 默认入口。只读世界、费用和交易视图并输出采样；不写游戏Memory、不持有可达的发送分支。无业务注册、无自动动作 |
| `single-shot` | 仅供未来单独授权的隔离实验使用。默认未武装；只有完整实验配置与一次性实验控制事实同时匹配，才在指定tick尝试一次100H发送。任何失败不自动重试 |

两者均导出实际可供Screeps装载的 `loop`（由现有工具生成兼容产物），不得仅有Node命令行main。**本轮只在本地假Game/Memory环境执行它们，不将任何产物上传。**

### 4.2 真实 API 薄包装与观测内容

源码路径应能直接使用 `Game.rooms`、Terminal `.store`/`.cooldown`/`.owner`/`.id`、`Game.market.calcTransactionCost()` 及 incoming/outgoing transactions；单次调用入口最后调用指定Terminal实例的 `.send()`。保持方法所属对象绑定。使用当前项目已有Screeps类型，字段不受现有类型覆盖时在实验侧做明确窄化，不改生产声明。

观察记录包含：实验ID、模式、当前tick和配置目标tick、来源/目标房间与结构ID/owner、两端H/energy/容量/cooldown、当前费用报价、实际观察到的交易字段、读取错误及截断状态。发送版另记录调用前、进入调用边界、同步返回或异常；**不得在API返回时自行改两端库存、创建交易记录或宣告"世界已经完成"。**

缺房间、缺结构、读失败不能被填写为"库存0、交易空数组且读取成功"。采样只报告原始事实及读取状态，不自己给出 `observed_committed`／`observed_not_executed`；不复制现有matcher。

官方API将 `send()` 的OK解释为请求已调度；游戏循环把脚本指令与随后世界更新分开。交易视图是有限历史，当前文档列出每方向最近100条。[R8–R9] 探针必须保留实际返回码和数据，不把这些文档描述当作本轮实验结果。实验侧读取的报价不使用fake的世界尺寸128或硬编码费用26。

### 4.3 单次调用的最小安全边界

实验场景继续固定 **W1N57 → W10N57、100H、同一合成用户、同一隔离shard、无Power、无其他writer**。调用版必须要求显式实验ID、完整关联描述、目标tick、期望用户/shard/两端结构身份及允许的最大费用。示例使用明显的合成值，默认不可发送，不自动读取正式配置补齐。

调用门禁至少保证：没有武装控制事实、模式不符、ID/路线/用户/shard/结构不符、目标tick错过、已经尝试、状态不健康或报价不可读/超预算时，零发送。只允许 `Game.time === targetTick`，不能使用"到时间以后一直重试"。在调用前标记已尝试；返回非OK或抛错后也不再次尝试。预算、结构与普通前置条件保持保守。

"正常模式未检查通过而没有调用"必须记录成探针前置拒绝，不能写成"已实测游戏API的ERR返回"。本轮不设计为了探测每种游戏拒绝而绕过全部保护的通用开关；真正的异常注入场景放入§5的待测计划。

**重要限制：**实验控制记录的Memory read-back也不是driver持久化承诺。这只是普通运行及"控制事实确实保留"的reset下的防重入/防重试约束，不能称为CPU/driver任意故障下exactly-once。未来不确定中断后，实验操作者应先切换只读并检查外部持久事实，不能自动恢复武装调用版；不要为了这个实验包新增持久许可、两阶段提交或永久防重放库。[R10]

允许单独的**实验控制记录**，但不写入 `Memory.runtime.treasuryCore` 或生产Memory声明：固定只存一个run，序列化不超过4KiB，不存逐tick交易历史、不按run无限追加。缺失/损坏时不自动初始化并发送；正常运行将其标记完成/停止但不自动再次武装。它一直有界保留到实验世界显式销毁或只读状态下的人工重置，不能以TTL重获发送资格。

只读入口仍不写该记录。实验控制的具体字段由实施者决定；实验ID和控制位都不是证明环境安全的凭证。

### 4.4 离线自测必须执行真实交付入口

使用本地stub/spy注入Game、Memory和Terminal API，执行同一源码及构建后的入口。这里的"send调用1次"只指spy调用，不是真实游戏经济动作。

最低覆盖：只读入口加载与多tick调用的零发送/零Memory写；single-shot未武装及错路线/错身份/错tick的零调用；合法目标tick恰一次参数正确的调用；同tick重复loop和后续tick均不再调用；同步非OK/throw不重试；保留实验控制事实的JSON重载和模块重建不重发；报价/交易读异常显式报告；读取记录不被自动改写为成功结论。

stub的 `.send()` 返回OK时**不修改库存、不给交易视图填记录**。测试随后显式切换到"后续tick观察fixture"，验证观察器报告输入中的差异。该测试只证明包装与采样正确，不证明引擎真的这样运行。正确保留same-ID镜像和不同ID记录，不能先删掉与预期不一致的数据再输出"原始记录"。

至少加载两个实际生成的JS产物做冒烟测试；仅检查源码字符串里有没有`send`或只测未被构建入口引用的helper不算完成。所有导入都不得产生发送、arm、网络或服务器副作用。

### 4.5 本地构建入口

交付 `scripts/build-treasury-terminal-lab.mjs`，默认构建observer，显式 `--mode single-shot` 只生成未武装调用版。建议命令见§7；路径/参数如调整，在固定提交前同步任务落实说明和测试。

构建器仅使用现有TypeScript/Rollup依赖，**不加载根rollup配置及部署插件**；不读取凭证、不提供上传参数、不回退`DEST`配置。构建过程不安装/启动引擎，不进行网络请求。输出到显式指定的独立目录，不覆盖 `dist/main.js`、生产构建、源码或已有非空目录；失败非零退出。从仓库外含空格路径执行也可定位自己的仓库与依赖。

输出一个简短清单：本仓库源SHA、构建模式、入口与bundle hash、依赖lockfile hash、固定参考engine/driver SHA、构建命令。清单明确 **PREPARED_NOT_RUN**。实验配置和清单不需要建设新通用schema平台。

两种产物只在本地生成并自测；observer必须与发送入口隔离，不能仅靠可被运行时改写的布尔开关让同一默认产物随时变成writer。single-shot产物虽包含调用代码，也不能在import时或缺配置时发送。

## 5. 工作 C：可执行实验交接说明，不再重复泛化设计

已有 `terminal-transfer-slice-0.md` §3只是计划文本。本轮在其旁新增短的实验包说明并从索引链接，明确旧版本接线细节以当前Remediation I/II实现为准，不批量重写历史报告。[R10]

**版本参考继续固定：**engine `80977824199a596d174d392fd0cf8c458c21fcbd`，driver `cf63d8adf902663e2ebddd7f8c5b7baa425dc928`。它们是读取过的源码基准，不是已经实跑成功的安装组合，也不代表正式服版本。说明未来如何确认实际安装的engine、driver、运行时、世界尺寸及依赖；没有确认的兼容性标"待实测"，不换成`latest`，也不要求本轮安装游戏服务。

交接说明必须能让后续获得授权的执行者按顺序建立**一次性新世界与合成用户**、安装两个Terminal、放置资源、先载入observer核对环境，再明确选择一个实验并武装single-shot。原型房间名是实验固定场景，不是正式服业务配置。真实F0与费用从环境读取，不照抄fake的100000空位/26能源。

仅交付以下矩阵，不一次实现所有故障注入器：

| 后续实验 | 需要得到的事实 | 本轮状态 |
| --- | --- | --- |
| 正常100H | 同步返回；调用tick与后续tick库存/费用/cooldown/两视图记录；同交易ID镜像 | 探针代码+离线自测完成；真实运行未执行 |
| 即时拒绝／处理层无结果 | 区分探针前置拒绝、API非OK、API已OK但后续无记录；不得以无记录证明未执行 | 记录方式具备；真实fixture与触发方法列计划 |
| 目标仅容纳60H | 是否实际缩量、实际amount及按实际量产生的费用 | 裸API对照计划，不声称国库在已知容量不足时会接纳100H |
| 普通global reset | heap变化、实际保留下来的Memory、库存、cooldown和交易可见性 | 离线接口覆盖；真实reset待授权执行 |
| CPU终止／Memory-intent保存不一致 | 真实driver层的Memory和intent独立留存组合、外部世界效果 | 只列切点与需取得的原始证据；本轮不写/执行超限或进程杀死注入器 |

**CPU超限不得以普通throw、Node强制异常、手动旧Memory覆盖冒充。**外部世界状态由真实引擎负责；以后复验一处中断时不能把世界和Memory独立拼成自己期望的答案。

实验包没有通用server launcher或上传器。本轮运行命令只包含本地构建与离线测试；未来的服务器创建、脚本上传和发送步骤统一标"单独授权后执行"，不从测试自动触发。若公开源码不足以给出可靠的启动命令，列明确环境前置条件，不编造"已验证一键启动"。

未来观测窗口固定且有限，例如最多32个tick采样；完整样本输出外部日志，不累计进游戏Memory。超过可采集容量则明确标记证据截断并停止采集，不能把截断当成无交易。停止步骤先撤销武装并保留observer，收集原始产物，再销毁一次性世界；不能把资源反向转回作为自动清理。

**环境隔离由外部运行流程保证。**`Game.shard.name`、用户名、实验ID都不能证明目标不是正式环境；这也是本轮完全不提供自动上传/连接入口的原因。后续只有拿到单独实验授权，才允许建立新实例；不连接用户已在运行的任何世界。

## 6. P01–P06 验收与停止条件

| 编号 | 本轮必须交付 |
| --- | --- |
| P01 | 注册settle入口实际读取100/60与60/100，两者unknown+责任保留；跨视图和正确唯一闭环保持；记录实际输入顺序 |
| P02 | 新VALIDATION_HEAD的第二干净代码树独立npm ci、独立node_modules/cache/output；本轮+KEY+Defense实际复跑，原始安装与测试结果齐全 |
| P03 | 实际可构建的observer和single-shot源码；真实API薄包装、原始采样、默认无写；不复制国库协议或对账器 |
| P04 | 两个构建产物在假端口上的行为测试；模式/身份/路线/tick门禁、无自动重试、OK不自造效果、受控reset、读取失败均明确 |
| P05 | 独立本地构建入口与产物清单；短实验说明包含版本前置条件、原始API与国库边界、待测矩阵、停止清理；真实状态标PREPARED_NOT_RUN |
| P06 | 生产/配置/依赖/Defense冻结；固定SHA验证和完整原始证据；最终执行代码先提交后验证，commit/push纪律保持 |

索引不是测试数，不要求人为凑6个it或另外一套几十项证明。P01/P02补交接；P03–P05交付新实验工具；两者结论分开。环境安装失败、探针自身行为失败、真实引擎未执行是三个不同状态。

不为了探针"足够通用"新增其他路线、自动补货、市场、生产配方、运输creep、自动rearm、部分量结算、永久审计或分布式实验编排。**本轮准备项完成即停止；不自行从PREPARED升级为真实运行。**

## 7. 固定提交验证与原始证据

### 7.1 提交次序

全部实际执行的源码、测试、构建器先提交；按真实收集滚动预算manifest和现有预算脚本锚点，固定 `VALIDATION_HEAD`。之后才跑主验证和第二树。旧O报告不改成新结果，原测试数字不预填本轮通过。

证据根：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-prep-i/`

只保留 `task/`、`final/`、`revalidation/` 和一份主报告即可。P01输入顺序、三笔账目、spy调用次数用小型日志表达，不复制全部旧证据或新建1MB轨迹格式。已有H18产物仍由原工具核验；不改其格式。

### 7.2 主验证模板

以下是待执行命令，非已完成记录。实施者须在固定提交前落实示例构建CLI和探针测试路径，或同步替换为实际路径。输出目录位于仓库外；默认正常测试不联网。

```bash
set -euo pipefail
unset DEST
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
START_HEAD=a03cac5f9735d3a63980c681a07ed3a9a13d978e
FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
VALIDATION_HEAD="$(git rev-parse HEAD)"
OUT="$(mktemp -d)"
printf '%s\n' "$VALIDATION_HEAD" > "$OUT/validation-head.txt"
printf '%s\n' "$START_HEAD" > "$OUT/expected-start.txt"
git status --porcelain > "$OUT/status-before.txt"
test ! -s "$OUT/status-before.txt"
node --version > "$OUT/node-version.txt"
npm --version > "$OUT/npm-version.txt"
run() {
  local name="$1" rc sep="" word; shift
  { for word in "$@"; do printf '%s%q' "$sep" "$word"; sep=" "; done; printf '\n'; } > "$OUT/$name.command.txt"
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
run typecheck npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run build npm run build
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/production-bundle-before.txt"
run lab-observer node scripts/build-treasury-terminal-lab.mjs --out "$OUT/lab-observer"
run lab-single-shot node scripts/build-treasury-terminal-lab.mjs --mode single-shot --out "$OUT/lab-single-shot"
mkdir -p "$OUT/foreign cwd"
(cd "$OUT/foreign cwd"; run lab-build-outside node "$REPO_ROOT/scripts/build-treasury-terminal-lab.mjs" --out "$OUT/lab-observer-outside")
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/production-bundle-after.txt"
cmp "$OUT/production-bundle-before.txt" "$OUT/production-bundle-after.txt"

SLICE_FILES=(
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts
)
LAB_FILES=(test/lab/terminal-transfer/probe.test.ts)
KEY_FILES=(
  "${SLICE_FILES[@]}" "${LAB_FILES[@]}"
  src/runtime/treasury/treasuryRemediationIVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVIKernel.test.ts
  src/runtime/treasury/treasuryRemediationIVService.test.ts
  src/runtime/treasury/treasuryRemediationVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVService.test.ts
)
for file in "${KEY_FILES[@]}"; do test -f "$file"; done
# 探针测试须自行构建到独立临时目录并加载真实产物；这里不运行游戏服务器。
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
run jest-full npx jest --config jest.config.cjs --runInBand --json --outputFile="$OUT/jest-full.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-budget"
run budget node scripts/verify-jest-budget.mjs
run verify-evidence node scripts/verify-treasury-evidence.mjs \
  --validation-head "$VALIDATION_HEAD" --run-dir "$OUT" --fixture h18
run diff-check git diff --check
git status --porcelain > "$OUT/status-after.txt"
test ! -s "$OUT/status-after.txt"
printf '%s\n' "$(git rev-parse HEAD)" > "$OUT/head-after.txt"
test "$(git rev-parse HEAD)" = "$VALIDATION_HEAD"
printf 'VALIDATION_COMPLETE\n产物目录：%s\n' "$OUT"
```

探针测试位于test目录，可能不被Treasury目录定向包含；报告单列LAB与各集合，不漏掉也不累加。预算自带全仓重跑单列，不覆盖主全仓JSON。生产bundle中不得包含新探针；独立实验构建不得修改生产bundle，上面比较的是同一次生产构建的前后值，不要求不同时间的生产build具有相同hash。

### 7.3 第二树与归档

使用§3.2的独立 `npm ci`，新的worktree必须同一VALIDATION_HEAD。记录安装是否修改tracked文件、lockfile是否相同、包解析路径、独立cache/output，再运行同一KEY_FILES与DEFENSE_FILES。保存完整控制台日志与Jest JSON，输出自己的P01输入顺序证据及探针离线记录。需要运行既有核验器时，传run根（里面有trace-key和jest-key.json），不是传trace子目录。

新实验包本轮没有实际engine运行，故不要创建伪装为实机结果的"engine-success.json"。主报告分别写：Slice 0交接是否完成、探针构建/离线自测是否通过、独立依赖复验是否完成、真实引擎 **NOT_RUN**。

验证后只能追加非执行性日志、数据和说明。新判定脚本、实际测试驱动或构建入口必须先提交再验证；命令实录作为文本归档，不能在证据目录后置可执行逻辑后继续沿用旧验证。新增源码/测试后重新固定并验证受影响范围。

不reset已推送历史、不rebase、不force push、不amend已推送commit、不合并main；push当前分支。提交前后核对 `git diff --check`、`git status --short`、`git log --oneline --decorate -40`，比对最终验证HEAD与交付HEAD的执行代码范围，查询status/checks/Actions；没有就标"无CI证据"。

**最终停止：**交付P01–P06、完整原始结果、可本地构建的实验包与后续实验说明。不得自动启动真实实验、上传两个产物中的任意一个，也不得发起真实调拨。

## 附录：固定定位与来源

以下项目源码均以 `a03cac5f9735d3a63980c681a07ed3a9a13d978e` 为编制基准；实施时核对实际行号。

- **[R1]** GitHub分支HEAD，本文编制时重新读取，仍为上述SHA。
- **[R2]** `test/test-suite-budget.json`：239／1440，预算引用`2099e564bd52ef0908e34b338c16c2a0717fa199`。
- **[R3]** `openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-slice-0-remediation-ii/final/validation-head.txt`：`fc5edf3bfa057cba254a0d6b4be4109b445f2d37`。
- **[R4]** `src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts` O01/O02：函数级两顺序、注册路径原记录+注入记录、跨视图与合法对照。
- **[R5]** `evidence/terminal-transfer-slice-0-remediation-ii/revalidation/README.md`与`REVIEWER-LOG.md`：上一轮独立代码树使用node_modules junction，不是独立依赖安装。
- **[R6]** 上一轮主报告及`treasuryTerminalTransferSlice0.test.ts`的M05/M07：普通和恢复链路投影断言已落地，继承限定通过，不重新修内核。
- **[R7]** 根`package.json`、`tsconfig.json`、`jest.config.cjs`：现有TypeScript/Rollup/Jest依赖；工作区覆盖`test/**/*.ts`，无需修改根配置即可放置实验源码与测试。
- **[R8]** Screeps官方API，2026-09-08核对：`https://docs.screeps.com/api/#StructureTerminal.send`、`https://docs.screeps.com/api/#Game.market.incomingTransactions`、`https://docs.screeps.com/api/#Game.market.outgoingTransactions`、`https://docs.screeps.com/api/#Game.market.calcTransactionCost`。只据此定义采样和调用契约，不冒充实机结果。
- **[R9]** 游戏循环：`https://docs.screeps.com/game-loop.html`，2026-09-08核对。
- **[R10]** `openspec/changes/empire-treasury-core-rewrite/terminal-transfer-slice-0.md` §1、§3：已有固定源码基准、Memory/intent持久化待测边界与隔离实验计划。§2部分接线描述属早期版本，当前归属/费用/单条在途实现以Remediation I/II源码为准。

不需要原聊天、历史探针ZIP或另一份任务书才能执行本文。本文件授权的是**开发、离线测试、构建、提交与推送**，不授权游戏世界上的任何写操作。
