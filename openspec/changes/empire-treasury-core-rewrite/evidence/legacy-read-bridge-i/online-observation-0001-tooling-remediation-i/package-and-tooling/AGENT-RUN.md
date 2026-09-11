# Treasury Legacy Read Bridge I — 发布工具修复与限定线上观察续行

**交付：已经实现的外部工具与测试。不是让你重新实现国库、兼容桥或测试计数器。**

本任务接续 `online-observation-0001`。上轮没有启用上传，已经通过的兼容桥与计数器修复保留。本轮先原样验证工具修复，再在执行会话的部署与恢复授权覆盖时完成原定小候选观察。旧原件不改写，失败不换窗口重试到成功。

## 1. 固定起点与已有成果

仓库：`ceyirelehe47/screeps-bot`。

| 用途 | 起点与归属 |
|---|---|
| 兼容候选分支 | `compat/treasury-read-bridge-i` |
| 候选起点，已含计数器修复 | `6a63a2aff064295ef65efc8def26c9865dfd9db3` |
| 开发／证据分支 | `refactor/empire-treasury-rearchitecture` |
| 证据起点 | `5b6afad054d5352a5bbc40d3dae31339c2a5a180` |
| 候选历史全量验收 | `6d514b5de2dd518596eab11865f2d841c9cb18e2`：195 suites / 685 Jest tests |
| 读取算法固定来源 | `01bd9831454950c4928df98dd8679692b55603e5`，既有8文件闭包不改 |
| 生产源基线 | `06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c` |
| 已知线上原件 | 单 `main`，4,494,463字节；SHA256 `37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b` |
| 原件的既有算法集合摘要 | `84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf` |
| 目标 | 官方服 `screeps.com`，`forster`，userId `634fe406347a7b69b28aeccb`，活动世界分支 `default`，观察 `shard1` |

这些是本轮比对基线，不是声称执行时线上仍未变化。前检必须重新读取；当前代码字节、账号或活动世界分支不符就停止部署，不能只看内嵌旧commit仍相同。

上轮通过：兼容候选离线验收；测试计数器修复；默认OFF；旧主循环38→39阶段；既有业务、Defense、预留与Memory生命周期未改。本轮不重新应用旧补丁，不重建另一个兼容桥，不重复100H裸API或国库本地实验。早期 `bd9570d…` 检查点只是历史，不是本轮起点。

**冻结：**候选只允许 `src/runtime/treasuryCompatConfig.ts` 的profile绑定及最后恢复OFF。桥、生成核心、main、旧业务、共享类型、依赖和Rollup不修改。本包工具运行在候选工作树外，不进入生产bundle。历史 `online-observation-0001/tools/` 保留原字节，不原地替换。

## 2. 授权与凭据

用户已经允许Agent使用本地新token，并自行办理官方临时免限流。**不要再为解除限流反复请示，也不要重新寻找历史泄露token。** 旧token失效、新token认证成功已有记录；本次需要的是使用当前本地凭据。

本地生成、测试、构建、GitHub线性提交和原范围必要读取可继续执行。线上覆盖及精确恢复沿执行会话已经明确的授权执行；已覆盖本次小候选、关闭与恢复时不逐命令确认。确实没有时，在准备阶段一次性确认：

> 对forster官方服当前default活动世界分支，启用一次由compat/treasury-read-bridge-i派生、仅增加限定观察的小候选；结束或异常时恢复本次上线前精确模块集合；不修改游戏Memory、不新增调拨／市场动作，不迁移整个重构分支。

仅收到“制作任务包”或“解除限流”的授权，不能代替上面的发布范围。未获授权先完成本地验收和准备材料，保留 `NOT_DEPLOYED`；不把未部署写成运行失败。

`--execute`是工具防误操作开关，不是授权来源。guard也可能恢复远端代码，因此启动guard之前必须已有恢复授权。

凭据从实际 `.secret.json` 的 `main` 项读取：目标必须为screeps.com、https/443、根路径、显式branch=default。允许省略协议／端口／路径以使用这些固定值；不允许auto或其他服务器。不把token放在命令参数、异常栈、进程CommandLine清单、截图或提交中。`SECRET`变量只存**文件路径**。

免限流查询：

```bash
node "$KIT/tools/token-status.cjs" --secret "$SECRET"
```

使用正确的 `/api/auth/query-token`。工具只输出实际数值／布尔的计时相关字段，不输出原响应、token或URL；字段为空不代表没有限流。必要时在受控浏览器完成官方Proceed流程，再查询并通过必要读取验证。官方流程是指定token的两小时临时窗口，涉及reCAPTCHA时不绕过真人验证；不要由HTTP 200推断免限流剩余时间。旧token窗口不能继承。免限流不是无界轮询许可。

不擅自停止用户现有长期监控。本包创建的collector和guard有单独runId、PID和目录；只管理本轮实例。日志出现429时保留状态码及数值退避提示，不保存带token的响应正文。

## 3. 本包已实现的修复及验收边界

| 修复 | 实际行为 |
|---|---|
| 活动世界分支 | 验证响应成功、唯一 `activeWorld=true`，始终向code读取传入明确branch；缺失、多义或错误类型拒绝 |
| 模块数据 | 失败响应、缺少modules、空对象、数组、null、非法二进制全部拒绝；备份也必须有有效非空文本main |
| 摘要与类型 | 从候选仓库按完整Git blob核验后加载既有deployGuard；用原集合摘要，**再同时检查逐模块精确类型／内容差异** |
| 精确恢复 | 仅当前==本次candidate才POST备份；第三方改变拒写；回读与活动分支再次核对；POST超时不自动重发 |
| 上传不确定 | 本地超时不当成服务器取消。如果一次启用上传结果未确定、当前暂时仍是原件，也不直接宣称已恢复；保持 `ONLINE_CLOSE_UNCONFIRMED` |
| 截止与挂起 | 单次HTTP请求最多8秒；恢复操作总预算40秒（包含最多10秒本地动作锁等待）；独立父guard最多等恢复子进程45秒，再请求终止，最多等2秒确认；失败保持不确认 |
| 采集活性 | 校验本轮runId、账号频道和shard；心跳文件更新不等于有效console流；连接无有效console超过45秒、心跳过旧或错实例均触发关闭 |
| 缺样本 | collector还活着也不能无限等；game/time辅助判断预定采样点／窗口，缺少连续采样覆盖会收尾，不延长窗口 |
| 日志安全 | 不输出原始异常消息／堆栈／HTTP错误正文；console中已知token、前缀和常见凭据形式脱敏，且标明原帧是否经过脱敏 |

原仓库集合算法对某些人为构造的文本／二进制内容也可能得到同样的输入串，所以本包不是只判断hash相同，还要求原函数的missing/extra/changed均为空。没有新增第三套库存或部署摘要权威。

**本轮上传路径有一处明确调整：**先用未修改的Rollup执行build-only，固定实际产物到会话快照，再用 `upload-once.cjs` 上传该快照一次。**不再执行会重新构建的 `npm run push`。** 否则guard提前绑定的candidate可能不是实际上传的那一份。新工具在上传前复用既有Git守卫，检查干净树、固定来源、账号、活动分支、新鲜房间归属／tick以及原件字节；上传后精确回读。没有修改原构建器，也不新增自动发布分支。

HTTP路径依据本仓库已使用的 `auth/me`、`user/branches`、`user/code`、`user/overview` 和 `game/time` 交互。新传输实现没有自动重试／重定向，也没有console注入、Memory写入、切活动分支、send/deal接口。正式服务端接受仍须本轮实际证据，不能以本地替身通过替代。

## 4. 离线验收：先原样验证，不重新开发

所有路径用本机实际绝对路径。`KIT`为本包，`REPO`为兼容候选工作树，`EVIDENCE`为工作树外的新目录。使用Node 22；真实候选的TypeScript仍来自其锁定依赖。

```bash
cd "$REPO"
unset DEST DEPLOY_ALLOW_DIRTY NODE_OPTIONS
# 不修改系统Git配置；仅按实际环境为测试子进程处理已知行尾差异。
git fetch origin
git status --short
git rev-parse HEAD
git branch --show-current

node "$KIT/tools/verify-package.cjs"
node --test "$KIT"/tests/*.spec.cjs > "$EVIDENCE/tool-tests.tap" 2> "$EVIDENCE/tool-tests.stderr"
# 立即记录上一条真实退出码，不用管道的tee状态代替。
node "$KIT/tests/mutation-check.cjs" > "$EVIDENCE/mutations.json"
node "$KIT/tests/candidate-boundary.cjs" --repo "$REPO" > "$EVIDENCE/candidate-boundary.json"
node "$KIT/tools/check-profile.cjs" --repo "$REPO" --mode off
```

本包测试100项，五种故障变异；内部测试数量不计入候选195/685预算。`candidate-boundary.cjs`必须实际运行，不能缺仓库就skip：它加载真实deployGuard并比较原函数、核对桥和生成核心字节。

`tests/cli-preload.cjs`只在测试子进程中注入回环服务器和替代端口；**正式执行禁止把该preload或测试NODE_OPTIONS带过去**。CLI测试的模拟Git／客户端入口与真实协议操作分开标注。所有网络替身只绑定127.0.0.1，未使用游戏token。

独立增加反例至少覆盖：activeWorld错误／多活动分支；成功与缺模块响应；文本／二进制区别；读取成功但恢复回读失败；挂起恢复与子进程无法确认退出；活PID但无有效console；日志IO故障；同一次启用重复调用；上传不确定后暂时读到原件。每类需合法正对照，不能靠另一个前置错误提前失败。

需要补的是上轮放在本地但未入库的必要定向原件，不是无意义重跑：能找回其70项Node、3/8 Jest及类型检查原件，就保留真实归属；找不到如实记录。候选源未变，本轮不机械重跑685项全仓和预算脚本。最终profile另做下一节专用类型检查、真实读取smoke与构建。

若工具失败，先保存原始输入（合成或已脱敏）、日志和退出码。允许修正本轮外部工具的实际接口／Windows适配，但要单独提交diff、重跑相关测试并记录新的TOOLING_VALIDATION身份；不能静默改桥、放宽比较、扩大重试或替换原件。生产缺陷交回，不现场扩建国库。

## 5. 最终profile、产物及会话准备

### 5.1 先做一次新鲜前检

```bash
node "$KIT/tools/preflight-read.cjs" --repo "$REPO" --secret "$SECRET" --out "$EVIDENCE/preflight-initial"
```

输出目录必须尚不存在，不能覆盖旧备份。工具验证实际账号、唯一活动世界分支、**已知原件的精确摘要**、内嵌生产来源、overview和tick，成功后才保存可用的备份与前检结果。

前检若发现不同代码字节，即使BUILD_COMMIT还是06ffedb也停止。不得改常量、关闭hash校验或靠相似文件大小放行。新鲜overview提供的是房间归属线索，不是独立Game Store库存真值；桥第一条有效样本才提供具体结构ID与直接Store读取。

首次范围仍只用E3N59、E4N58中已确认的1–2个房间，固定energy/H。相对初始tick选择100的整数倍S，给本地提交和构建留足余量；正式上传前还必须至少有100tick提前量。保持：

- `startTick=S`，`endTick=S+1100`，100tick间隔，12个预定点。
- `minBucket=2000`、`maxSampleCpu=2`、`reserveCpu=5`、`maxLogBytes=16384`。
- 上线前允许因准备时间耗尽重新绑定S，但须记录、重新提交与验证；**第一次启用上传attempt创建后不改S、不换run目录重新启用**。

只改 `src/runtime/treasuryCompatConfig.ts`，在候选分支提交 `PROFILE_HEAD`。不要再改计数器或重发旧补丁。

### 5.2 从干净、detached的构建树生成一次产物

这里使用detached构建树，是因为现有build-only的Rollup会把Git分支名用作部署分支标记；detached下现有默认标记为default，与本轮实际活动分支一致。**不是手改bundle元数据，不是改变源码来源。** 候选分支仍正常保留PROFILE_HEAD。

```bash
git worktree add --detach "$BUILD" "$PROFILE_HEAD"
cd "$BUILD"
unset DEST DEPLOY_ALLOW_DIRTY NODE_OPTIONS
npm ci
node "$KIT/tests/candidate-boundary.cjs" --repo "$BUILD"
node "$KIT/tools/check-profile.cjs" --repo "$BUILD" --mode on --observed-tick "$INITIAL_TICK"
node "$KIT/tools/profile-smoke.cjs" --repo "$BUILD"
npx --no-install tsc --noEmit -p tsconfig.build.json
npx --no-install tsc --noEmit -p tsconfig.json
npm run build
```

独立npm ci不共享node_modules；可使用下载缓存。`BUILD`仅用于本次构建和工具核对，证据与任务包不得放进去污染clean tree。

构建完成后再做最终前检与快照固定：

```bash
node "$KIT/tools/preflight-read.cjs" --repo "$BUILD" --secret "$SECRET" --out "$EVIDENCE/preflight-final"
node "$KIT/tools/prepare-session.cjs" --repo "$BUILD" --preflight "$EVIDENCE/preflight-final" --run "$RUN"
```

`RUN`是新的受控工作树外目录。工具校验profile、实际bundle的commit/tree/dirty/目标branch、内嵌bundle摘要及完整模块；保存backup/candidate两份完整快照和内容指纹。最多使用15分钟前的最终前检。**原件、预构建产物、实际上传文件、内嵌摘要分别记清，不混成一个hash。**

不能通过修改生成物、补写“正确身份”字符串、手改session摘要来让准备通过。实际Rollup输出形状与检查器不兼容时，只修解析器并保留正反对照，不修改游戏产物。

## 6. 先启动有效收集与恢复guard，再上传固定快照一次

启动前确认：部署／恢复授权已覆盖，当前无人或其他自动化并发发布同一账号活动分支；本轮前后都保留这种发布互斥。REST前检＋回读**不是服务器CAS**，不能保证并发第三方写入之间的原子性。

以下进程应当在执行Agent实际会话中持续受监督，不交给无人管理的定时提醒。不同终端／会话进程共享同一个RUN；记录实际PID，不dump全机器CommandLine。

```bash
# 进程1：只订阅本轮账号的console/cpu；不注入表达式。
node "$KIT/tools/console-collector.cjs" --repo "$BUILD" --secret "$SECRET" --run "$RUN"

# 进程2：持有本轮精确恢复授权的截止执行者。
node "$KIT/tools/deadline-guard.cjs" --repo "$BUILD" --secret "$SECRET" --run "$RUN" --execute
```

等同一个runId的heartbeat确实处于streaming且收到目标shard的合法console帧，再检查guard-ready是否新鲜、PID存在。空console帧只证明连接活性，不证明桥运行或旧bot健康。guard最多等15秒初始有效通路，准备阶段最长15分钟，不会无限常驻。

```bash
# 默认是只读预演；不会POST。
node "$KIT/tools/upload-once.cjs" --repo "$BUILD" --secret "$SECRET" --run "$RUN"

# 只有范围授权和前置均满足才执行。只POST已固定的candidate快照，不重新构建。
node "$KIT/tools/upload-once.cjs" --repo "$BUILD" --secret "$SECRET" --run "$RUN" --execute
```

本地一次性attempt在POST前落盘，重复调用拒绝；使用同一run目录的动作锁串行化上传和恢复，避免guard与上传同时写。锁异常不能自动删除或创建新run绕过；只能在确认本轮所有相关进程已退出、核对远端当前状态后，作为记录在案的人工安全处置处理。

**上传报错不再次启用。**可能已经上传时也只能读取并走安全恢复。没有收到成功响应、不代表服务端未接受；曾发起但结果不确定、现在读到原件时，工具不会直接据此报告“从未启用／已恢复”。确有延迟应用风险则保留不确认；至多做有界的必要读回与明确授权的安全恢复，不无界追读、不制造第二次启用。

本包已将原定90分钟截止与这次POST前的attempt时间绑定，不从Agent什么时候再次打开终端重新计时。guard同时使用单调时间，墙钟后退不能重开已用额度。

### 观察与中止

自动guard处理：最后预定样本到达、game/time越过endTick、墙钟90分钟、collector失效／心跳过期、采样长期缺失、核心Store比较不一致、桥fault、连续部分报告、报告中的完整采样CPU超过5。

并非把全部验收交给一个布尔状态：执行Agent仍须观察旧bot主循环异常、真实部署标签、旧口径差异以及已有遥测的bucket。连续两份新鲜遥测bucket<2000、不能解释的新增业务异常、部署身份变化等，使用下面的关闭请求立即收尾。不能把“脚本未自动报错”当作健康证明。

```bash
node "$KIT/tools/request-close.cjs" --repo "$BUILD" --run "$RUN"
```

这是本地关闭请求，不是“已关闭”。最终看guard/restore结果、精确模块回读和随后实际运行身份。

guard通常500毫秒检查本地状态；game/time最多每15秒补充读取。日志收到末端样本则不等下一次time轮询。HTTP等待受剩余预算限制，但调度与I/O不是硬实时系统：报告实际触发时刻、请求时刻与确认时刻，不能宣称90分钟内已经原子完成远端恢复。截止指到点发起有界关闭，不是忽略恢复耗时。

### 原定采样判读不变

目标至少6个不同tick的完整样本，覆盖绑定端点；至少5条能归属到采样tick的完整成本。最多12个预定点，材料充分可提前关闭；不足就标有限／不确定，不延期刷满。

对照项：`authorizesActions=false`、`spendable=null`、`kernelLifecycleRun=false`、`facadeQueryRun=false`；directStatus、真实ID和getCapacity、energy/H；原函数coreComparison；旧tasks/reservations输入状态与索引完整性。`sampled`不等于所有字段完整；缺失／不可读／省略不等于零。

`legacyProjection.mismatch`与核心Store比较差异分开，不靠改旧表消除差异。容量按实际读取处理，不固定1M/8M；未观察到技能切换不宣称覆盖过。非空任务未在本轮实际出现，就只继承离线非空用例，不伪造线上覆盖。

CPU使用 `previousRun.cpuIncludingEmit` 按它的tick归属；最后一条缺少下一份报告时用原profiler或如实记未取得。首次加载与部署tick成本单列；2CPU是协作式读取预算，不是不可突破的硬上限。`retainedPrimitiveChars`不是VM实际内存字节。

## 7. 恢复、默认OFF和证据交付

guard恢复前重新认证账号与活动分支，严格判断当前模块：

- 当前是candidate：发送备份一次，随后回读完整类型／内容及活动分支。
- 当前是备份且无未决启用：幂等，不写；有未决启用不能简单据此确认关闭。
- 当前是其他产物：拒绝覆盖，报告冲突，不用旧备份覆盖另一个操作者的新代码。
- 不可读／超时／日志失败：明确不确认；绝不通过 `{}` 补值。

`ONLINE_BYTES_RESTORED`只证明本次回读时字节已经恢复。还要取得随后新鲜的玩家部署身份／主循环推进证据；停止收集或窗口静默不替代这些事实。不能回滚Memory来完成关闭。旧业务自然发生的库存与Memory变化不属于新桥写入。

恢复进程45秒仍不退出，父guard请求终止**自己启动的单个Node worker**并最多等2秒确认；不能确认时仍返回不确认，不扫描或终止其他Node进程。网络请求本地超时／杀进程不等于服务端动作取消。

本轮collector看见本run的guard终态后自动结束；仍要核对自己的进程与footer。强制OS终止可能没有footer，已保存帧和进程退出证据分别记述，不能删失败记录补造正常footer。用户其他监控不处理。

线上确认恢复后，在候选分支把profile恢复已验收OFF，提交 `CLOSED_SOURCE_HEAD` 并运行off检查；**不上传这个关闭构建**，线上保留的是备份原字节。PROFILE_HEAD、启用快照和失败原件留作历史。

证据归档新增目录（在开发／证据分支）：

`openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/online-observation-0001-tooling-remediation-i/`

保留包原件及摘要、实际执行工具源码、原始测试TAP/JSON/退出码、最终profile与产物身份、前检摘要、必要原始console／逐样本索引、上传与恢复状态和独立判读。**这轮可公开的测试原件必须随提交，不能又只写“保存在本机”。** 完整线上模块、全量Memory和原始敏感数据留受控目录，不提交；对外原帧若脱敏应明确标注，未脱敏原件不得为证明“原始”而公开。

候选与证据分支分别线性commit/push；不要merge整个重构分支到候选，不reset、不force、不amend已推送历史。工具源码单独记录版本，不能以旧脚本的测试结论覆盖修改后的新脚本。无需为外部工具修改候选Jest预算。

最终回答六项：工具实际版本与执行测试；是否上传及唯一attempt；实际样本／有效覆盖；真实成本与缺失；精确恢复与运行侧确认；候选默认OFF及两个分支最终SHA。

建议标签仍沿用：准备完成未部署 `TOOLING_VERIFIED / NOT_DEPLOYED`；材料充分且已恢复 `ONLINE_COMPAT_READ_OBSERVED / RESTORED`；不足但已恢复 `ONLINE_COMPAT_READ_INCONCLUSIVE / RESTORED`；恢复不确认单独 `ONLINE_CLOSE_UNCONFIRMED`。标签不能替代原始证据，也不能升级为“完整国库上线”或新增经济动作授权。

## 8. 制作方实际验证与尚待Agent完成

制作方在Linux / Node 22.16.0执行了100项工具测试，包含回环HTTP、实际Node WebSocket收集、大帧与脱敏、实际CLI的上传一次／重复拒绝／子进程恢复，以及实际创建的挂起Node子进程终止；五种临时故障变异被检出。

测试中的游戏服务是127.0.0.1替身，CLI的候选Git入口／凭据入口有明确测试注入；没有连接游戏、使用真实token、调用Screeps上传或对实际玩家世界采样。两段原deployGuard函数在参考文件中按已读取源码保存，正式工具从候选完整文件按Git blob验证后加载；**在制作环境没有完整候选检出，所以 `candidate-boundary.cjs`、真实TS5.9.3 profile smoke、真实Rollup产物准备、Windows进程／文件行为与官方服务端上传仍须Agent完成。**

完整Git访问本轮实际尝试返回DNS失败，原始输出在validation。不能把本地100项和候选历史195/685拼成“新全仓通过”。

来源：固定GitHub候选／证据SHA、上一轮审查包及实际Rollup/deployGuard源码。官方token流程参考 `https://docs.screeps.com/auth-tokens.html`；HTTP与游戏领域协议以已读源码／实际响应确认。90分钟、12采样点、5CPU和本地恢复预算是本轮操作约定，不是平台可靠性定理。
