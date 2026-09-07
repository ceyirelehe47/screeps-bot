# Empire Treasury — Terminal Transfer Slice 0
## 候选交接、真实引擎契约核对与首条调拨链路的离线适配准备

**用途：开发 Agent 直接实施、测试、归档、commit、push。本文自包含。**

编制日期：2026-09-07。状态：**待执行，不是验收通过报告或部署许可。**

任务身份：**Terminal Transfer Slice 0**；验收索引 **M01–M08**。承接 Core Candidate Seal I · Evidence Remediation I（L01–L08）。本轮不是 Remediation VII，不是继续建设证据平台，也不是 Core Rewrite V。

> 结束既有证据工具的功能补修。只把后置核验脚本纳入一次正确的提交／运行边界，然后把工作主线转到一种业务：两间自有房间之间的小额度 Terminal 矿物调拨。本轮交付源码依据、可运行的离线 adapter 原型和下一阶段的隔离引擎实验准备；不接生产 writer，不执行任何真实游戏转运。

---

## 1. 起点、继承结论与不变边界

| 项目 | 编制时重新核对的结果 |
| --- | --- |
| Repository | `ceyirelehe47/screeps-bot` |
| Branch | `refactor/empire-treasury-rearchitecture` |
| 本轮实施起点 | `1b1279ff7161ffc6f2bee31daec1c3fe619184da` |
| 持续保留的生产冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 上轮代码／测试验证 HEAD | `d9cd60e07f4c4e7559aec14383ee805aea0e2051` |
| 当前预算引用锚点 | `5360e6669d79a514165e4daf9a3af9a46f58ea70` |
| 上轮全仓原始结果／当前预算 | 236 suites／1420 tests／1420 passed；失败、pending、todo、runtime error 为 0 |
| 上轮定向结果 | KEY 5／57；Treasury 32／574；Defense 11／118。集合可能重叠，不能累加为独立测试总数 |
| OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |
| 持久内核 | `Memory.runtime.treasuryCore`；schema v3；attempt 使用 `tk1_` |
| 限制保持 | active 64；recent ring 128；核心 JSON 字符预算 360,000；生命周期每 tick 8 份；外部释放每项成对预扣 2 份、至多 4 次／tick；每记录至多 8 个消费者、12 条 worstCase 腿；fresh 限额不变 |

这些数字来自 Agent 已提交的运行证据和远端预算，不是本文编写方的独立测试结果。[R1–R4] 实施时先 fetch：若远端前移，核对增量、沿最新历史继续，不退回旧提交或覆盖别人的工作。

**继承结论：**持久关窗、健康满载恢复、V1 无损风险提取、V2 逐检查点核验，以及 V3 原始复验产物的主要缺口，已通过上一轮限定审查。本轮不重新实现它们。没有已确认需要解冻生产内核的新缺陷。尚有后置可执行核验脚本的交付纪律保留项，按 §2 一次收尾。

### 1.1 本轮明确允许和禁止什么

允许：读取公开官方文档和开源源码；新增测试目录中的 Terminal 调拨原型及定向测试；整理已有核验驱动的可移植入口；更新必要预算元数据、OpenSpec 和原始证据；Git commit/push。

禁止：修改生产 kernel、facade、actionContracts、coverage、observation、生产 testHarness、生产装配、配置依赖或 lockfile；部署／上传游戏代码；运行 `npm run push`、`npm run local`；调用真实 `terminal.send()`、`Game.market.deal()` 或其他经济 writer；使用正式账号、PTR、现有私服、玩家 Memory 或凭证。**本轮不启动任何真实游戏服务器，也不因“只是私服”而自动放开调用。**

离线测试只能使用显式注入的本地假端口，测试启动必须与线上 runtime 无关。所有新原型只在测试中装配，不进入生产 bundle，不通过环境变量悄悄开启线上路径。公开源码下载可以联网，默认 Jest／核验脚本不得依赖网络。

不新增生产持久字段、永久 proof、另一套许可／余额／重试权威；不扩容，不放宽 validator；Defense 生产行为保持冻结。真实 engine/driver 的中断与持久化关系仍未经实验验证，不宣称 exactly-once 或真实 Screeps CPU 保证。

---

## 2. 工作 A：核验脚本一次性收尾，不再扩大封板任务

上一轮三个文件在 `d9cd60e…` 验证之后才于 `9035f40…` 提交：

- `evidence/core-candidate-seal-i-evidence-remediation-i/final/verify-seal-trace.mjs`
- 同目录 `check-jest-json.mjs`
- `evidence/core-candidate-seal-i-evidence-remediation-i/revalidation/verify-seal-trace.mjs`

它们调用的主要核验 helper 已在验证提交中，但驱动本身不在该提交内；不能继续以“在 evidence 下、不被 Jest 收集”解释成没有可执行变更。[R3]

**处理方式：**旧原件和日志保留历史身份，不重写旧 SHA。把本轮需要继续使用的驱动整合为一个小型、可移植、显式接收输入路径和源码版本的已提交入口；推荐 `scripts/verify-treasury-evidence.mjs`。只整合现有调用，不重写风险比较器，不新增归档平台。不要求统一全部历史文件扩展名。

入口从当前固定提交加载现有 `test/mock/treasurySealEvidence.ts`，核验指定 H18 产物及原始 Jest JSON。H18 的 expected 使用本轮已固定的夹具约束（20 个指定 unknown、12 个观察窗口），不要把待检查文件的 `actualTicks` 当作 expected。路径缺失、零输入、版本不匹配或任一核验失败，返回非零；正常产物返回零。不得使用旧 Windows 临时目录或隐含 cwd 才能运行。

驱动及必要的最小自测先提交，再在本轮 `VALIDATION_HEAD` 上执行，保存输入 hash、helper blob、驱动 blob、命令、退出码和原始输出。这样关闭保留项。**不为这三份旧驱动再复跑每一轮历史实验；最终公共回归中正常运行 L／H／J 用例即可。**

---

## 3. 工作 B：固定首条业务范围，核对真实引擎契约

### 3.1 本轮选定的原型业务

测试场景为：**A 房间已有矿物 H 存放在 Terminal，向 B 房间 Terminal 调拨 100 H。**

两个房间均由同一测试用户持有、同一 shard、可见；结构均可用；发送前源 Terminal 资源和运费能源充足。每个独立场景只有一条在途调拨，重试关闭；不并行运行市场、搬运、生产或其他修改这两个 Terminal 的业务。100 H 是原型夹具值，不是已批准的正式服额度。

先支持这个明确场景，不扩展为任意资源路由器：不做能源作为货物、不做多人交易、不做自动补货 planner、不接运输 creep、不处理 Power 加成、不做批量调拨与自动补发。可以在负向测试中构造条件变化，但不能因此展开一套新业务框架。

### 3.2 已核对的来源与实施者必须完成的短报告

公开文档将 `send` 的 `OK` 描述为成功调度，交易记录提供有限历史。编制时读取的官方开源 engine 提交是：

`80977824199a596d174d392fd0cf8c458c21fcbd`（提交主题 4.3.2）。

它只是**可复核的开源源码基准**，不代表已确认正式服使用完全相同的版本。[E1–E5]

必须阅读下列路径，按固定 SHA 留下链接／行号与关键结论；无需复制整个 engine 仓库进本项目：

| 来源 | 需要核实的含义 |
| --- | --- |
| `src/game/structures.js` 的 `StructureTerminal.prototype.send` | 前置检查、返回码、写入 send intent 与返回 OK 的关系；同源同 tick 重复设置 intent 的行为 |
| `src/processor/intents/terminal/send.js` | 处理阶段重新检查资源／费用后写入发送信息；API 接受与处理成功不是同一步 |
| `src/processor/global-intents/market.js` 的 `executeTransfer` 与 terminal send 分支 | 世界存量更新、交易记录写入、冷却、目的地条件与部分转运 |
| `src/game/market.js`、`src/utils.js` 与官方 API | 可见交易字段、费用与距离计算；记录窗口和描述文本处理 |
| runner／相关 driver 路径（只追踪此次动作有关部分） | 脚本结束、intent 提交与 Memory 保存的接口边界；源码不能证明的异常顺序标为待实测 |

**已经看到的关键差异：**该固定 engine 的 `executeTransfer` 会按目标剩余空间缩小实际 amount，并按实际量继续处理。100 的请求可能只产生 60 的转运；不能把自己的“目标空间预检”当成引擎永不发生部分转运的证明。API 入口也不是最终交易记录的产生点。[E3–E4]

短报告按“官方文档／固定源码事实／原型假设／仍待真实实验”分列，重点回答：

1. OK 时知道了什么；何时能够看到最终效果与记录。
2. 全量、部分转运和处理阶段未完成如何区分；未知返回／异常不能变成全额成功。
3. 怎样把一条**实际读取的交易记录**关联到此 attempt，而不是只比较金额或 room。
4. 查询不到交易为什么通常不能证明未执行；历史被挤出、读取不全时保留什么责任。
5. 当前 kernel 的调用边界／观察覆盖，与延迟生效模型在哪些位置需要实测；不能把 Memory 对象 read-back 说成 driver 已持久化。

输出一个紧凑的差异清单与最小实验计划即可。不得以完成这份报告为名无限研究其他 writer。

---

## 4. 工作 C：实现测试专用 adapter 原型，复用原内核

建议新增 `test/mock/treasuryTerminalTransferPrototype.ts` 与 `src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts`；辅助可以合并，内部类型由实施者自行设计。注册只用既有测试注册能力。**不得在生产 `actionContracts.ts` 中注册它。**

已核对的现有接口可复用：[R5–R7]

- `TreasuryActionAdapter`：validate、derivePostings、structureBindings、durableFacts、execute、reconcile；已有 `settlesOnAccept`／`nonOkOutcome`，无需新增结果协议。
- `TreasuryService`：authorizeTreasuryActionContract、executeAuthorizedDispatch、settleUnknownOutcome、kernelJournal，以及原有 begin/end、取消和关闭入口。
- 当前 command 已支持“外部接受但 outcome_unknown”，随后由注册 reconciler 提供结论。

### 4.1 单一参数来源与完整预算

canonical 参数决定源结构、目标房间、资源、数量和关联描述；派生同一份 postings、结构绑定及有界 durable facts。不得让调用者独立提交另一份 postings／手续费／假结论。

无 Power 的首个场景中，至少有三项责任：源 Terminal 的 `−100 H`、源 Terminal 的 `−fee energy`、目标 Terminal 的 `+100 H` 接收空间。运费从核对后的费用规则及可信报价端口派生并冻结；执行前条件变化或报价不一致时不得使用陈旧、偏低的预算继续调用。测试中报价由显式本地端口提供，不能调用真实玩家 API。

资源够、费用能源不够也应拒绝；目标空间不够、目标不属于本场景、源／目标 incarnation 改变、结构不可用、业务输入非法，都应有明确拒绝和零提交对照。复用 facade 的现有资源／容量／身份检查，adapter 仅补本动作特有条件，不复制一个通用授权引擎。

### 4.2 执行只表示提交，不能同步记成全额完成

原型明确 `settlesOnAccept=false`。本轮可以保守使用 `nonOkOutcome="unknown"`；预调用条件失败应尽量在进入提交端口前拒绝。不要为了减少 unknown 再新增返回协议；只有已证明同步拒绝语义的路径才可以有依据地分类 not_executed，不能按任意 false／未知数字猜测。

execute 只调用注入的 **fake submit** 一次。fake 返回 OK 时只记录待处理请求，**不立刻改变房间库存、不立即产生可见成功交易**。后续测试步骤推进处理和新 tick，才提供新的资源观察与模拟 API 交易视图。这是基于来源的离线模型，不是真实引擎运行证据。

同一 test coordinator 顺序推进生命周期，不再允许这个原型从回调递归调度。记录未结束时拒绝另一条调拨需求；该限制必须从当前 active 工作读出，不能仅靠跨 reset 会丢失的局部布尔量。不要新增持久锁或第二个队列。

### 4.3 结果识别：只接收公开形态证据，不读取测试 oracle 的“答案”

reconcile 从显式只读的交易视图端口和适用观察取事实；不能读取 fake 宿主内部的 outcome 字段或私有事件表，也不能让调用者传入 `observed_committed`。宿主内部事件只给测试断言核对实际调用，不给被测 reconciler 自证。

为单条请求选择一种可解释的关联方式：例如在 canonical description 内固定安全 ASCII 关联键，并在已有有界 durable facts 中保存。关联键在接纳前确定，API 参数、持久事实和对账使用同一值，不能执行时另换。**游戏交易的 transactionId 不等于 Treasury 的 tk1_ attemptId。**

关联键的唯一性范围必须写清。本轮使用隔离夹具控制的 run/request 身份，不制造新的生产 nonce 发行器。若准备以后用于真实环境，必须说明跨 reset 不复用的来源和如何绑定 actual attempt；无法成立就列为适配前置条件，不宣称随机串天然提供永久唯一性。关联键不是权限，用户可见 description 也不是签名。

只有在本场景中唯一匹配且无矛盾的记录，结合至少不早于其效果可见时点的源／目标观察，才允许报告**全量** committed。核对来源／目标、发送方／接收方、资源、实际量、时间关系、关联描述及适用身份；排除市场订单记录、他人的交易和旧请求记录。同一游戏交易 ID 在 incoming/outgoing 两个视图出现时是同一条事实，不是两次效果；同 ID 内容矛盾则阻断。具体使用一个还是两个官方视图由源码契约决定，不强行新增跨视图证明链。

无记录、记录过期／窗口不全、只有库存变化、只有相同参数、多个不同交易 ID 同时匹配、异常读取或部分转运，都不能被解释为全量完成。对“请求100、实际60”，报告可定位的部分结果／不支持状态并保持保守责任，**不直接丢弃剩余40、不自动补发40、不把该attempt重新执行**。本轮不设计通用部分结算状态机。

关闭自动重试；不实现 retryFacts 或按现有能力明确禁用 rearm。没有交易记录不能给出 not_executed。可能长期 unknown 的有限记录允许 fail-closed；本轮不靠 TTL 删除它，也不新增永久异常 store。

### 4.4 观察与退出必须贯穿延迟生效

调用发生于 tick T，但测试世界尚未处理请求时，即使再次构建观察、观察序号增大，也不能凭该序号宣告效果已覆盖或释放责任。reconcile 必须以真实来源契约约束可见时点；不要通过伪造 Game.time、手动编辑 invocationBoundary 或提前修改库存把旧同步模型伪装成兼容。

正常对照应走：合法接纳 → 一次假端口提交 → 接受但未知 → 处理与新 tick 观察／交易可见 → 注册 reconciler 结算 → 既有 cleanup 退出。最终源减少100H与实际费用、目标增加100H；完成前占用保留，适用新观察后不双扣，退出后不重复执行。

至少一次恢复从真实调用路径取得的 Memory 快照开始；对应宿主请求队列／世界／可见记录必须来自同一切点。完整 JSON 重载、新模块和 registry 重建后，用同一 pending 业务的持久 facts 对账，不能依靠旧闭包中的期望值。不要再开发通用分支回放器；沿用原 harness 能力，局部补测试装配即可。

若当前接口无法可靠表达某个必要事实，保留最小可运行反例和合法对照，标记 **ADAPTER_GAP**；继续完成其他可执行部分，但不解冻 kernel、不绕过许可、不把失败用例 skip 后报告全通过。这说明首条真实接线还缺哪一块，不推翻此前限定模型的封板结论。

---

## 5. M01–M08：本轮有限验收范围

索引是工作分组，不要求恰好八条 Jest 用例或创建八个文件。

| 编号 | 必须交付的行为或证据 |
| --- | --- |
| M01 | 已提交、可移植的核验驱动在新固定 SHA 实际运行；旧脚本保留历史身份；正常输入通过，缺输入和失败输入非零；不重写风险 helper |
| M02 | 固定官方源码与 API 的短报告：接受／处理／可见交易／部分量／历史窗口／Memory与intent边界；事实、假设、未实测事项区分；开源版本不冒充正式服版本 |
| M03 | 原型仅测试装配，生产／配置／Defense 零差异，无默认注册、无网络发送能力；同一请求的 canonical args、三腿责任、结构绑定和 durable facts 一致 |
| M04 | 正常100H含fee可接纳；分别仅降低H、仅降低费用能源、目标空位不足、源结构替换及超出场景输入均拒绝且提交增量0；恢复合法条件正常成功 |
| M05 | 延迟完成正向闭环：OK之后当tick仍未知且责任保留；下一适用观察与唯一全量记录后结算退出；源／目标／fee真实假宿主计数吻合，提交恰一次、余额不双扣 |
| M06 | 无记录、相同参数不同关联键、历史窗口缺失、读异常、不同交易ID重复匹配、实际部分量均不报全量完成／不补发；两视图同一交易不重复计数；正确唯一记录仍可完成 |
| M07 | 提交后结果持久化前及已接受未处理的代表性断点，使用配对宿主状态完整重载；先保持unknown，再在可见事实到达后收尾；旧许可拒绝、同工作不重发、未知时第二需求仍阻断 |
| M08 | 固定SHA主验证与第二上下文定向复验；旧脚本保留项独立结论、新原型结果和ADAPTER_GAP如实标注；提交一份后续隔离引擎实验说明，不自动执行 |

原有 L／H／J／I 关键回归正常复跑，不另增几十个旧证据工具变体。新的反例只针对本业务实际边界；测试全拒不能替代 M05 的正常退出。

---

## 6. 交付目录与后续实验说明

沿用原 OpenSpec。新增 `terminal-transfer-slice-0.md`，集中放来源契约、原型接线、适配差异和下一阶段实验说明；tasks／test-migration-map 只追加索引与定位，不复制整份设计。

本轮原始证据根：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-slice-0/`

保留 `task/`、`sources/`、`final/`、`revalidation/` 和简短主报告即可；需要负向原件可加 `controls/`，不强求目录数量。所有原始文件按运行分开，包含命令、退出码、SHA、关键原件与来源。无需把整份1MB轨迹在每个小测试中重复保存。

`terminal-transfer-slice-0-local-validation.md` 分别说明：旧脚本收尾是否完成、原型与来源核对是否完成、未知／部分结果的保留策略、是否存在适配阻断、测试在哪个模型运行。旧产物不改写成新运行。

**后续真实引擎实验说明只准备，不执行：**列明一次性隔离环境的版本锁定方法；仅使用合成账户／新世界；单向100H、无其他经济writer；观察tick T返回、后续tick的两端存量／费用／交易；全额、即时拒绝、目标空间变化、global reset和CPU终止分别需要的证据；关停新增动作后如何继续恢复。真实driver窗口未知处写待测，不能用Node throw或本轮fake代替。任何真实实例创建、游戏代码上传或真实API调用均待单独授权。

完成说明之后停止，不自行生成下一轮永久证明系统或启动正式服影子运行。

---

## 7. 实施顺序、固定验证与 Git 纪律

### 7.1 顺序

1. 读取本任务全文，报告实际文件、分支／HEAD，核对未提交工作；fetch并确认增量。
2. 先做 §2 核验入口的最小整理，再完成源码短报告和测试原型；不要等待再次批准。
3. 在开发树运行定向测试，修正原型／测试内问题；新发现的生产或引擎契约差异单列，禁止静默改kernel。
4. 提交全部执行性变更、测试、驱动、自测、必要预算元数据，再固定 `VALIDATION_HEAD`。以下完整主验证只在最终候选提交执行一次；之后若改执行代码则重新固定相关验证。
5. 在同 SHA 的第二干净 worktree 复跑新 M 集合、KEY集合、Defense与核验驱动。实际独立 reviewer 优先；没有则明确同执行者复现，不冒称独立审计。任务全文须提供给 reviewer。
6. 验证完成后归档，提交日志／数据／说明，Git push。后置新增可运行脚本不能再称“只是胶水”；脚本原件需在固定提交中，后续可以引用其 blob。

### 7.2 验证模板

下列新路径为本任务建议交付路径；若选择其他路径，在固定验证前替换为实际路径并记录。结果全部写到仓库外，不在验证期间归档回工作树。

```bash
set -euo pipefail
unset DEST
FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
VALIDATION_HEAD="$(git rev-parse HEAD)"
OUT="$(mktemp -d)"
printf '%s\n' "$VALIDATION_HEAD" > "$OUT/validation-head.txt"
git status --porcelain > "$OUT/status-before.txt"
test ! -s "$OUT/status-before.txt"
node --version > "$OUT/node-version.txt"
npm --version > "$OUT/npm-version.txt"

run() {
  local name="$1" rc; shift
  printf '%q ' "$@" > "$OUT/$name.command.txt"; printf '\n' >> "$OUT/$name.command.txt"
  if "$@" > "$OUT/$name.log" 2>&1; then rc=0; else rc=$?; fi
  cat "$OUT/$name.log"; printf '%s\n' "$rc" > "$OUT/$name.exit-code.txt"
  return "$rc"
}
run production-freeze git diff --exit-code "$FREEZE_BASE" "$VALIDATION_HEAD" -- \
  src ':(glob,exclude)src/**/*.test.ts' ':(glob,exclude)src/**/*.spec.ts'
run config-freeze git diff --exit-code "$FREEZE_BASE" "$VALIDATION_HEAD" -- \
  package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs

git diff --name-status --no-renames "$FREEZE_BASE" "$VALIDATION_HEAD" > "$OUT/changes-from-freeze.txt"
run typecheck npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run build npm run build
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/bundle-sha256.txt"

KEY_FILES=(
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts
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
run jest-full npx jest --config jest.config.cjs --runInBand --json --outputFile="$OUT/jest-full.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-budget"
run budget node scripts/verify-jest-budget.mjs
# 若核验入口采用不同CLI，替换下面实参并保存真实command，不能不运行。
run verify-evidence node scripts/verify-treasury-evidence.mjs \
  --validation-head "$VALIDATION_HEAD" --run-dir "$OUT" --fixture h18
run diff-check git diff --check
printf '%s\n' "$(git rev-parse HEAD)" > "$OUT/head-after.txt"
test "$(git rev-parse HEAD)" = "$VALIDATION_HEAD"
git status --porcelain > "$OUT/status-after.txt"
test ! -s "$OUT/status-after.txt"
```

新增的核验驱动自测等若不在上述路径中，要单独保存实跑结果。预算按真实收集更新，不删旧用例、不加skip/only、不硬凑1420。budget自带重跑单独标注，不覆盖主全仓原始JSON。第二工作树独立路径／cache／输出，保存自己的KEY、Defense、M场景日志与JSON，不把重叠定向集合重复计数。

检查生产冻结时还须分类 `test/`／`scripts/` 变更：不把生产代码搬进豁免目录。构建嵌入时间／Git身份，hash用于追溯，不要求与上轮相同；源冻结依赖实际diff。

Git纪律：不reset已推送历史、不rebase、不force push、不amend已推送提交、不合并main。最终报告列实施起点、生产冻结基线、预算锚点、验证HEAD、交付HEAD；验证后只允许非执行性归档。最后执行 `git diff --check`、`git status --short`、`git log --oneline --decorate -40`、`git push origin refactor/empire-treasury-rearchitecture`，并核对远端HEAD。查询checks／Actions，空结果标无CI证据。

---

## 8. 完成定义与停止条件

本轮成功不是“又增加了一层证据”，而是同时交付：

**一项交接收尾：**继续使用的核验驱动已经纳入固定提交并实跑；历史保留项有准确说明，不改写旧运行事实。

**一份业务原型：**通过已有内核完成100H调拨的离线延迟生效路径，能拒绝非法输入、保留未知与部分结果的责任；原型完全不进入生产装配。

**一份来源明确的差异与实验说明：**写清哪些由公开源码支持、哪些只是本地假端口测试、哪些必须由真实engine/driver实验回答。若存在ADAPTER_GAP，明确它及可运行证据，不用通用新架构掩盖。

M01–M08逐项报告真实状态。正常原型通过不自动升级国库全部运行模型；源码阅读不等于真实引擎实跑；编制后续实验说明不等于执行授权。完成后停止，保持不部署、不调用真实writer、Defense冻结。

---

## 附录：固定来源

项目来源锁定 `1b1279ff7161ffc6f2bee31daec1c3fe619184da`：

- [R1] 分支最新commit；本文编制时通过GitHub connector再次核对。
- [R2] `test/test-suite-budget.json`：236／1420，5360e666…预算锚点。
- [R3] `openspec/changes/empire-treasury-core-rewrite/evidence/core-candidate-seal-i-evidence-remediation-i-local-validation.md`及该轮两份verify-seal-trace.mjs：实质修复、后置脚本与来源限制。
- [R4] 同证据根`freeze/validation-head.txt`：d9cd60e07…；各运行结果是Agent提交证据。
- [R5] `src/runtime/treasury/actionContracts.ts`：TreasuryActionAdapter、settlesOnAccept、nonOkOutcome、有界durableFacts。
- [R6] `src/runtime/treasury/facade.ts`：TreasuryService，注册reconciler结算入口与已有门禁。
- [R7] `src/runtime/treasury/kernel/commands.ts`：dispatch_start／dispatch_result／settle／观察覆盖，不能把同步模型推断直接迁入真实引擎。

外部原始来源（访问日期2026-09-07；实施时按固定版本核对）：

- [E1] 官方API：`https://docs.screeps.com/api/#StructureTerminal.send`；费用、描述和返回语义。
- [E2] 官方API：`https://docs.screeps.com/api/#Game.market.outgoingTransactions`、`https://docs.screeps.com/api/#Game.market.incomingTransactions`；交易字段与有限历史。游戏循环：`https://docs.screeps.com/game-loop.html`。
- [E3] `https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/game/structures.js`，Terminal.send；同SHA的`src/processor/intents/terminal/send.js`。
- [E4] `https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/global-intents/market.js`，executeTransfer与send分支；编制时已读目标空间缩量及交易插入路径。
- [E5] `https://github.com/screeps/engine/commit/80977824199a596d174d392fd0cf8c458c21fcbd`。其他driver依赖须记录实际读取的版本；未经核对不引用其行为。

Defense冻结生产文件：`src/runtime/defenseFocusFire.ts`、`src/runtime/engagementFallbackRevision.ts`、`src/runtime/defenderRampartAllocation.ts`、`src/runtime/homeDefense.ts`、`src/runtime/towerControl.ts`、`src/runtime/physicalRampartOwnership.ts`、`src/roles/homeDefender.ts`。
