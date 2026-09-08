# Empire Treasury — Terminal Transfer Engine Lab Prep I · Remediation I
## 发送前标记确认、失败路径产物验收与编译配置交接

**用途：开发 Agent 直接实施、离线测试、commit、push。本文自包含，不需要聊天历史、上一份任务书或审查 ZIP。**

编制日期：2026-09-08。状态：**待执行任务书，不是通过报告，不授权真实引擎运行。**

任务身份：**Terminal Transfer Engine Lab Prep I · Remediation I**；验收索引 **Q01–Q06**。承接 P01–P06 的审查；不是 Terminal Transfer Slice 0 · Remediation III，也不是国库内核重写。

> 本轮只修一个明确的执行条件：single-shot 必须确认“本次已尝试”标记成立，才能进入发送。补齐实际构建产物的失败路径测试，并说明实验配置如何进入产物。已有 Slice 0 逻辑、P01 排列补验与 P02 独立安装成果不退回，不新增国库协议或实验管理平台。

## 1. 起点与继承结论

| 项目 | 编制时核对的值 |
| --- | --- |
| Repository | `ceyirelehe47/screeps-bot` |
| Branch | `refactor/empire-treasury-rearchitecture` |
| 预期起点／上一轮交付 HEAD | `749d44c94bf35a12abcbdeda9e5842e9b27a9c6b` |
| 上一轮最终代码／测试验证 HEAD | `dde2e802007b4153508ddee2715e0e254cfba491` |
| 上一轮实现／预算引用锚点 | `6ac563b514119c8107a7a328f4794ac9c9ca9ad8` |
| 持续生产冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 已提交全仓结果／当前预算 | **240 suites／1454 tests／1454 passed**；failed、pending、todo、runtime error 均为 0 |
| 上轮定向结果 | KEY 9 suites／91 tests，含 LAB 1／11；Treasury 35／597；Defense 11／118。集合重叠，不相加 |
| 当前内核 | `Memory.runtime.treasuryCore`，schema v3，attempt `tk1_` |
| OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |

以上计数是上一轮 Agent 归档的运行证据，不是本轮结果。编制时重新读取了远端 HEAD、budget 和 validation-head；实施前仍须 fetch。若分支前移，检查增量后沿现有历史继续，不 reset 回本表 SHA，不覆盖他人工作。

**继续保留的限定通过：**

- Slice 0 的精确交易归属、先归集后判全量、固定路线、单条在途、冻结费用、延迟确认、unknown 责任保留，以及普通／恢复链路 closing 不双扣。
- P01：注册 `settleUnknownOutcome` 实际读取 `[100,60]` 和 `[60,100]`，歧义均保留责任；唯一全量正常退出。
- P02：上一轮第二工作树已经独立 `npm ci`，不再使用 junction。不要把它重新写成未完成。
- observer／single-shot 双入口、独立构建器、正常假端口行为和“不在 OK 后自造世界效果”已有实现。

**本轮审查结论：**single-shot 的发送前标记失败仍继续调用，是已在归档 JS 产物上用 Node VM 假端口复现的问题；配置交接是说明缺口。两者均不构成已确认的生产内核缺陷。真实引擎仍为 **NOT_RUN**。

## 2. 允许修改与明确禁止

优先只改以下位置；内部函数、返回类型和测试拆分由实施者自行设计，不固定一套新 schema。

| 位置 | 本轮允许内容 |
| --- | --- |
| `test/lab/terminal-transfer/controlRecord.ts` | 控制记录读写的明确失败结果、大小检查、发送前读回核对所需逻辑 |
| `test/lab/terminal-transfer/singleShot.ts` | 未确认标记则零发送；发送后结果写失败不撤销 attempted |
| `test/lab/terminal-transfer/probe.test.ts` | 实际生成 JS 的回归、故障与合法对照；必要时拆入同目录测试 |
| `test/lab/terminal-transfer/sendGate.ts` | 仅为控制事实健康检查所需的最小接线；不扩展世界门禁和动作面 |
| `test/lab/terminal-transfer/labConfig.ts`、`example.experiment.json` | 澄清编译配置与文档示例身份，保持合成值及默认未武装 |
| `scripts/build-treasury-terminal-lab.mjs` | 默认不改行为；仅当配置来源追溯确有必要时作小型说明／清单修正 |
| OpenSpec、本轮 evidence、测试预算元数据 | 当前任务说明、实际结果、索引与真实收集计数 |

**冻结**生产 kernel、facade、actionContracts、coverage、observation、生产 testHarness、主入口及经济装配；冻结 Slice 0 adapter/coordinator、通用 reset harness、Seal 核验工具、observer 的只读语义；冻结根 `package.json`、lockfile、Rollup／TypeScript／Jest 配置与 Defense 生产代码。没有反例依据，不顺手重构其他文件。

核心 active 64、recent ring 128、核心 JSON 360,000 字符、生命周期 8 份／tick等既有上限不变。实验控制仍只占一个独立槽 `Memory.__labTerminalTransferProbe`，不写入国库 Memory，不扩为多 run 历史。

**本轮不执行：**`npm run push`、`npm run local`、服务器／容器／数据库启动、游戏代码上传、真实 `terminal.send()`、真实市场交易、CPU 超限或 driver 故障注入。不得读取或复制正式凭证、`.secret.json`、PTR／现有私服配置及玩家 Memory。允许按既有 lockfile 安装开发依赖，允许本地构建和假 Game／Memory 测试。

## 3. 基线反例：先真实复现，再修改

### 3.1 已定位的调用链

当前 `writeControlRecord()` 返回 `void`：序列化超限时记录拒写后返回，赋值异常被 catch 后同样返回。`singleShot.loop()` 不检查结果，也不读回匹配事实，随后直接调用 `gate.sourceTerminal.send()`；发送后写 `stopped` 也可能失败。

因此：

```text
armed=true、attempted=false 的记录被门禁接受
→ attempted=true 的更新没有成功
→ 调用方仍进入 send
→ 结果更新也失败
→ 同 tick 再调 loop，原记录仍 attempted=false
→ 再次进入 send
```

固定基线产物在起点提交：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-prep-i/final/lab-single-shot/single-shot.js`

旧产物身份：17,520 字节；Git blob `6ce38daaaabff1febab3e710ac948f4e7cdaa7db`；SHA-256 `9d8bfc54d542b9b5e8e37113b87e0f06e29149b7fa3cac1b9a7b8dfc7794ed4f`。先核对字节身份；不下载或执行任何游戏服务。

审查方此前实际跑的是该产物的假端口 VM，不是完整仓库 Jest，也不是真实游戏。实施者须保存自己本轮的复现输出，不抄已有结果。

### 3.2 三个固定失败场景与对照

每组使用新的 VM／模块环境；其他前置条件全满足；目标 tick 调两次 `loop()`，再推进一个 tick调用。send spy 只记调用，不修改库存、冷却或交易记录。

| 场景 | 旧产物累计调用轨迹 | 修复后要求 |
| --- | --- | --- |
| 未武装，Memory 正常 | 0／0／0 | 仍 0／0／0 |
| 正常武装、普通小记录、写入正常 | 1／1／1 | 仍 1／1／1 |
| send 返回非 OK，写入正常 | 1／1／1 | 仍 1／1／1 |
| send 抛错，写入正常 | 1／1／1 | 仍 1／1／1 |
| 控制槽 setter 抛错 | **1／2／2** | **0／0／0** |
| 控制槽 setter 静默丢写，getter仍返回旧记录 | **1／2／2** | **0／0／0** |
| 初始可读记录未超限，加入 attempted 信息后超限 | **1／2／2** | **0／0／0** |

第三个失败场景应使用普通可写对象，不依赖 setter：在合法必要字段外附加 ASCII note，使原始 JSON 长度为 4090；旧产物增加 attemptedTick 后为 4111，写同步结果后为 4160，均超过其 4096 限制。用程序补齐 note 长度并断言前后尺寸，不依赖手工数字符。初始值只作为合成测试输入，不能放进真实 Memory。

修复可以在读取阶段明确拒绝不支持／无法安全更新的记录，也可以在构造待写值时拒绝超限；**最终必须是零发送，且正常小记录不受影响**。不得扩大上限、先删除原控制记录、偷偷删除输入内容后冒称原更新成功，或跳过实际loop入口来让测试通过。若新策略在读取时拒绝额外字段，报告应如实标为读取拒绝，不声称执行到了写入超限分支；已有写入函数对超限候选的拒绝仍须有针对性断言。

基线运行只证明旧行为；修复验收使用正确预期。不要把“旧漏洞仍发生”的断言留作正式绿灯标准。旧产物仅供隔离 VM 对照，不复制为新的交付 writer。

## 4. 工作 A：发送以“匹配的已尝试事实”为前提

### 4.1 最小正确顺序

保留现有世界门禁、成员方法 this 绑定、指定 tick、固定100H及一次性实验范围。调用流程必须满足：

```text
读取配置与当前控制事实，现有门禁通过
→ 构造独立的本次 attempted 更新值并检查大小
→ 尝试写入实验控制槽
→ 重新读取该槽，确认与本次 expected attempted 状态匹配
→ 只有明确成功才进入实际 send 调用边界
→ 记录同步返回／异常，尝试补写结果与停止状态
→ 不自动重试、不撤销已尝试事实
```

具体函数和类型自行设计。要求是实际调用方可区分“已确认”与“未确认”；不能仅把 `void` 改成恒 true，不能靠日志是否打印成功推断。也不能只检查赋值没 throw——静默丢写必须被真实读回发现。

读回必须重新从控制槽取得数据，不是比较待写对象自身或缓存引用。至少核对本次实验ID、预期 attemptedTick、`attempted===true`以及资格／停止事实无冲突；缺失、错误类型、读回异常、旧值、错误实验ID／tick都不能被当成匹配。不要只检查“槽里有一个对象”。不得通过原地修改此前读出的对象，让丢写测试仍看到 attempted=true。

### 4.2 发送前失败与发送后失败分开

**发送前：**序列化失败、超限、赋值异常、静默丢写、读回失败或不匹配，都结束本次调用，send spy=0；不打印声称已经进入实际发送的 boundary／sync-return，也不伪造 API 返回码。诊断应指向探针自身的标记失败，不是游戏 API 的拒绝。

**发送后：**同步返回与结果是否成功写回是两件事。预标记已确认后，send 可能返回 OK、非 OK或抛错；结果记录再失败，不得用旧的 `attempted=false` 覆盖、回滚或删除已确认标记，不得再次发送，也不能谎报 stopped 已保存。可以在外部日志如实记录同步结果与结果记录失败。

若预标记事实上已写入，但读回失败，则本轮保守不发送；该记录可以维持 attempted 状态，等待后续只读检查，不自动清除以便再发。此标记只阻断重试，不证明世界效果发生。

若实际已经进入发送，而后续控制事实遭外部丢失／回滚，仍属于未证明的 driver/环境边界。本轮不要求重建不存在的事实，不用新的持久票据、双槽提交、永久防重放记录来宣称解决任意崩溃。

### 4.3 容量与控制事实生命周期

实验记录固定只存一个 run，原 **4KiB** 上限不增加；读入与拟写出的值都必须符合支持的形状和大小约束。unknown字段可明确拒绝，不把任意输入展开成无限可增长历史。错误文本等可选诊断也不能使结果保存侵蚀或撤销 attempted。

日志明确区分字符数与字节数；上面的 ASCII 反例两者相等。若保留非 ASCII 文本，应使用明确的大小口径兑现4KiB限制，不在 Screeps产物里引入 Node专属 Buffer依赖。

没有控制记录、不健康记录仍不自动初始化或武装；正常结束仍不自动重置；不按 TTL 重新获得调用资格。无需新增持久字段；确需测试侧局部辅助，保持单一run、可销毁的既有边界。

### 4.4 不在本轮扩大保证

“写入并读回匹配”仅是**当前脚本内的确认**，不是 driver 已提交到持久存储，不证明 CPU 中断下 exactly-once。同 tick 重复 loop、正常后续 tick、控制事实确实保留的 JSON重载／模块重建是本轮验证范围。

不重新设计回调调度、防重入平台或任意恶意 getter 模型。新增读回用例只模拟本次标记确认所需的失败点。不得以“全面拒绝”代替合法路径，亦不得自动 retry／rearm。

## 5. 工作 B：实际生成 JS 的失败路径验收

正式测试优先扩展 `probe.test.ts` 的既有构建装配；必须先由本仓库构建器生成两个新产物，再加载真实 `loop`，不得只mock `writeControlRecord`的返回值来测一个不相连的helper。

除§3固定矩阵，补以下紧邻路径；不要求人为凑固定 it 数量：

| 路径 | 必须实际验证的事实 |
| --- | --- |
| 正常预标记 | 在 send spy 入口内读取 Memory，确认匹配的 attempted 已成立；不是只在 loop结束后检查最终记录 |
| 写后读回异常／旧值／错误ID或tick | 其他前置检查成立，故障确实发生在标记后的读回；零send，并有失败原因 |
| 预标记成功，结果更新才抛错／丢写 | 第一更新保留匹配 attempted；send共1次；同tick再次loop、下一tick、保留该标记的JSON重载及模块重建后均不增发 |
| 预标记成功，结果因诊断长度超限 | send共1次；结果可拒写或有界记录，但不能破坏已有attempted；如实现不保存长诊断，验证其有界策略及原始返回不被改为成功 |
| 正常OK／非OK／throw | 正常目标tick调用恰1次，参数与this正确；世界未被spy自行修改；后续不自动重试 |
| observer回归 | 加载及多tick调用零发送、零Memory写；原始记录、缺失和读取异常如实报告；不导入writer链 |

故障注入器不得自己写 attempted=true 来替被测实现完成保护。覆盖同 tick重复调用后，必须断言实际 spy累计数，不能只断言日志有“拒绝”。读回异常用计数／明确阶段使第一次控制读取成功，避免只测到入口读失败。

每组隔离世界与模块，恢复所有 descriptor／spy。send返回OK的stub仍不更新资源或交易视图；实际世界效果一律未模拟为同步成功。结果写失败对照中不要回滚预标记，再声称证明跨reset安全。

输出一张小型原始结果表即可：场景、初始尺寸、预标记写／读结果、三时点累计send数、最终关键控制事实。Jest JSON与日志保留；不建设新的轨迹格式或独立验证框架。

## 6. 工作 C：把编译配置交接说清楚

**继续采用现有编译时配置，不新建动态配置通道。**本轮不增加 `--config`、热加载、运行时配置store或上传器，也不引入真实实验身份。

当前唯一配置来源是 `test/lab/terminal-transfer/labConfig.ts` 的 `LAB_EXAMPLE_EXPERIMENT`；singleShot模块据此派生调用版模式。`example.experiment.json` 是随包分发的文档示例，构建器当前只复制它；运行时不读取此文件。Memory控制记录只负责既有实验ID与武装／尝试／停止事实，不会覆盖编译进产物的路线、用户、结构、预算和targetTick。

更新同目录注释与 `terminal-transfer-engine-lab-prep-i.md` 的现行交接步骤，至少明确：

1. 本轮保留合成默认配置，两个产物都不上传。未来取得单独实验授权后，先在一次性世界只读确认期望身份与时点，不能自动读取正式配置补齐。
2. 将经确认的配置写入 `labConfig.ts`；同步文档示例。**修改JSON或Memory附加字段不会改变已有产物**。不允许只修改已构建JS而继续沿用原hash与验证声明。
3. 配置属于源码变化：重新固定源码提交、重建两个入口、验证生成物与配置对应，记录源码SHA和产物hash；只读版仍无writer分支。
4. 只有未来单独获准的实例操作才包含上传、控制记录武装及实际调用；切换只读／撤销武装和保存外部证据的步骤继续保留。错过targetTick不自动续期或改为下一tick。

可沿用已有manifest的源码SHA、入口hash及lockfile hash追溯；没有必要加新清单协议。若做极小的配置来源标注，先提交再验证。现有构建产物测试继续核对编译常量、示例文件及实际调用参数；不要求为此实现第二条配置装配方式。

本轮说明与报告均保持 **PREPARED_NOT_RUN／真实引擎 NOT_RUN**。不要修改历史报告伪造当时已完成，新增本轮短报告并从现行说明链接即可。

## 7. Q01–Q06 验收与停止条件

| 索引 | 完成要求 |
| --- | --- |
| **Q01** | 在固定旧产物上真实复现setter抛错、静默丢写和4090→超限三例；保存正常对照和产物hash；新产物同场景全零发送 |
| **Q02** | 发送前显式确认写入与真实读回；异常／旧值／错ID或tick拒绝；send入口内能观察到匹配attempted；正常路径仍可调用 |
| **Q03** | 预标记已成功后，结果更新失败不会回退attempted、重试或谎报停止已持久化；普通与保留事实的reset对照通过；控制记录保持有界 |
| **Q04** | 编译配置源、JSON示例、Memory控制三者角色明确；改配置需重新提交／构建／验证；不新增动态配置、上传或真实运行能力 |
| **Q05** | actual observer/single-shot构建产物回归通过；P01/P02、M/N/O及既有KEY／Defense不退化；生产与依赖冻结 |
| **Q06** | 新固定验证SHA、真实budget、完整原始输出及第二干净依赖环境复验；执行代码先提交后验证；commit/push与NOT_RUN边界保持 |

索引不是测试数量。不得复制大量上一轮证据充当本轮结果。P01/P02已通过的结论保留，新提交的复跑只是回归确认。

如产物测试暴露同一标记流程中的必要问题，提交最小修复与对应反例。无证据不扩展生产逻辑；与本范围无关的建议单列，不阻止当前限定任务正确交付，也不自行扩成新架构任务。

## 8. 固定提交验证

### 8.1 实施与提交顺序

先复现旧产物，再实现并运行目标测试。所有源码、正式测试、构建器或实际承担新判定的脚本必须先提交；按真实收集更新 `test/test-suite-budget.json` 与现有预算脚本锚点，固定新的 `VALIDATION_HEAD`，然后运行主验证与第二树。

**本轮证据根：**

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-prep-i-remediation-i/`

保留 task、baseline、final、revalidation 与一份主报告即可。baseline里的命令／测试源原件以文本归档；正式可执行逻辑放在已验证的源码／测试位置。构建生成的JS是从已验证源码产生的产物，记录hash，不与验证后手工新增判定脚本混淆。

### 8.2 主验证命令

下列为待运行模板，不是已执行结果。使用 Bash；Windows可等价运行，但需让Node与shell识别同一真实临时目录。**输出目录新建后不得再整目录删除；驱动不要把自己及日志放进随后会清空的路径。**

```bash
set -euo pipefail
unset DEST
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
START_HEAD=749d44c94bf35a12abcbdeda9e5842e9b27a9c6b
FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
VALIDATION_HEAD="$(git rev-parse HEAD)"
OUT="$(node -p 'require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "treasury-lab-r1-"))')"
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
run slice-implementation-freeze git diff --exit-code "$START_HEAD" "$VALIDATION_HEAD" -- \
  test/mock/treasuryTerminalTransferPrototype.ts test/mock/treasuryTerminalTransferCoordinator.ts
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

LAB_FILES=(test/lab/terminal-transfer/probe.test.ts)
SLICE_FILES=(
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts
)
KEY_FILES=(
  "${LAB_FILES[@]}" "${SLICE_FILES[@]}"
  src/runtime/treasury/treasuryRemediationIVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVIKernel.test.ts
  src/runtime/treasury/treasuryRemediationIVService.test.ts
  src/runtime/treasury/treasuryRemediationVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVService.test.ts
)
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
for file in "${KEY_FILES[@]}" "${DEFENSE_FILES[@]}"; do test -f "$file"; done
run jest-lab npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${LAB_FILES[@]}" --json --outputFile="$OUT/jest-lab.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-key"
run jest-key npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${KEY_FILES[@]}" --json --outputFile="$OUT/jest-key.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-treasury"
run jest-treasury npx jest --config jest.config.cjs src/runtime/treasury/ \
  --runInBand --json --outputFile="$OUT/jest-treasury.json"
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

若拆分了新测试，固定提交前把真实文件加入LAB_FILES，不漏跑、不用零收集冒充完成。LAB位于test目录，Treasury目录定向不包含它；主报告单列LAB、KEY、Treasury、Defense、全仓和budget重跑，不累加重叠数。

### 8.3 第二树复验与交付

在同一新的 `VALIDATION_HEAD` 建干净detached工作树，实际独立运行 `npm ci --no-audit --no-fund`。node_modules不得junction／symlink／复制另一树安装；可共享npm下载缓存。保留安装原始输出、退出码、版本、lockfile hash、实际依赖解析路径、独立Jest cache和输出目录。

reviewer读取本任务全文，复跑LAB、SLICE、KEY、Defense，重点独立检查**发送前标记失败为0次调用，结果写失败仍只1次调用**。不用第二树重复全部长压力。没有独立reviewer则如实标“同一执行者第二树复现”；安装失败保留ENV_BLOCKED，不偷换为共享安装。不要复制主树结果充当第二树执行。

归档包含本轮任务原文、旧产物hash与基线原始结果、新产物／manifest及hash、故障矩阵实际输出、Jest日志与JSON、冻结diff、验证SHA、完整命令和退出码。执行驱动不要在验证后才首次入库；一次性命令实录以文本保存，不能把手写通过摘要替代原始结果。

主报告分别回答：Q01–Q06完成情况；P01/P02回归是否保持；探针边界是否修复；配置交接是否明确；独立环境复验情况；**真实引擎NOT_RUN**。控制写入与读回的证据不得写成driver持久化证明。

验证后只追加日志／数据／说明及由该次构建生成的产物归档。若再改源码、测试或执行判定脚本，重新固定SHA并验证受影响范围，不继续沿用旧通过声明。核对最终验证提交到交付提交的src/test/scripts及配置差异。

保持线性提交：不reset已推送历史、不rebase、不force push、不amend已推送commit、不合并main。push当前分支并核对远端HEAD；记录 `git diff --check`、`git status --short`、`git log --oneline --decorate -40`，查询statuses/check-runs/Actions，无结果就标无CI证据。

**本轮完成即停止：只交付探针局部修复、产物验收与配置说明。不启动服务器，不上传observer或single-shot，不发起真实调拨，不自动进入下一阶段。**

## 附录：定位与事实来源

以下定位均以起点 `749d44c94bf35a12abcbdeda9e5842e9b27a9c6b` 为准，实施时确认实际行号：

- 分支HEAD、`test/test-suite-budget.json`、`evidence/terminal-transfer-engine-lab-prep-i/final/validation-head.txt`：本轮编制时重新读取的三个版本锚点。
- `test/lab/terminal-transfer/controlRecord.ts`：void写入函数、超限与赋值异常返回；`singleShot.ts`：调用后未检查结果仍进入send。
- `test/lab/terminal-transfer/probe.test.ts`：现有真实生成物加载、合法门禁、不重试与保留控制事实的reset测试。
- `test/lab/terminal-transfer/labConfig.ts`、`example.experiment.json`、`scripts/build-treasury-terminal-lab.mjs`：编译常量、文档示例复制及独立构建行为。
- `openspec/changes/empire-treasury-core-rewrite/terminal-transfer-engine-lab-prep-i.md`：需澄清的现行配置交接说明。
- 同目录evidence中的上一轮主报告与revalidation原始产物：既有P01/P02通过和运行范围；不作为本轮已执行的替代。
- 审查方产物级探针的固定旧JS及hash已在§3给全；无需取得聊天附件，也能从仓库复现。审查结果只涉及假端口调用次数，不涉及真实转运效果。
