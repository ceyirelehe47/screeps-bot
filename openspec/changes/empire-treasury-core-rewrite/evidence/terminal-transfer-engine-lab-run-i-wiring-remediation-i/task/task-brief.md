# Empire Treasury — Terminal Transfer Engine Lab Run I · Wiring Remediation I
## 观察模块装配失败即阻断发送；保留单向依赖与原实验边界

**用途：开发 Agent 直接完成限定实现、离线验证、commit、push。本文自包含，不需要聊天记录或审查 ZIP。**

编制日期：2026-09-09。任务身份：**Engine Lab Run I · Wiring Remediation I**；验收索引 **T01–T04**。这是 Run I 新增 main 的局部接线修复，不是 Lab Prep I · Remediation III，不是 Slice 0 重写。

> 本轮只改一条依赖关系：main 无法加载 observer，或 observer 没有可调用的 loop 时，本次调用立即结束，不再解析或调用 single-shot。反方向不成立：single-shot 不可用时，已有只读观察仍继续。不得把这项修复扩展成新的健康证明、持久锁或实验平台。

## 1. 起点、当前状态与继承结论

| 项目 | 编制时重新核对的值 |
| --- | --- |
| Repository | `ceyirelehe47/screeps-bot` |
| Branch | `refactor/empire-treasury-rearchitecture` |
| 预期起点／上一轮交付 HEAD | `457b052e1c7300a91a8b85c6337cfbf244968ce0` |
| 上一轮最终代码／测试验证 HEAD | `15b027bc3f002b97219001a8766fd6d6e0e78736` |
| 当前 budget baseline／target 引用锚点 | `afe839d028b9521592d8493bcfb9a2194d04fec1` |
| 当前 budget target／上轮归档全仓结果 | **241 suites／1472 tests／1472 passed**；failed、pending、todo、runtime error 均为 0 |
| 上轮定向结果 | LAB 2／29（probe 22、runI 7）；KEY 10／109；Treasury 35／597；Defense 11／118；Slice 0 三文件共23 tests。集合重叠，不相加 |
| 持续生产冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |
| 真实引擎状态 | **AUTHORIZATION_REQUIRED／NOT_RUN**；上轮仅完成离线接线，没有安装或启动游戏服务、装载、武装或发送 |

开始时 fetch 并核对远端。分支前移则先检查增量，沿现有历史继续，不 reset 回本表 SHA，不覆盖他人工作。上述计数是上轮 Agent 归档证据，不是本轮结果，也不是本文编制方重新运行全仓的结果。

保留已有通过结论：国库内核、Slice 0 的完整归属／单条在途／冻结费用／closing 不双扣；P01 注册 settle 双排列；P02 独立依赖安装；Q 发送前标记写入及读回确认、结果失败不重发；R 完整 JSON 的 UTF-8 字节数≤4096。main 的正常23 tick窗口、只在目标tick调用和错过不补调也继续保留。

**本次已确认的问题是新 main 的装配失败分支，不是重复发送漏洞，不是真实转运已经发生，更不是生产内核缺陷。**

## 2. 修改范围与明确禁止

默认只改：

| 位置 | 允许内容 |
| --- | --- |
| `test/lab/terminal-transfer/runIMain.ts` | observer 装配失败时立即返回；保留先观察后发送、既有异常退出和窗口规则；修正“两路互不阻断”的错误注释 |
| `test/lab/terminal-transfer/runI.test.ts` | 扩展现有产物装配的模块故障注入与断言；保留正常和反方向对照 |
| 现行 `terminal-transfer-engine-lab-run-i.md`、tasks及本轮 evidence | 更新这条依赖关系、本轮结果和真实运行状态；不篡改历史报告 |
| 测试预算元数据、`scripts/verify-jest-budget.mjs` 的已有预算常量 | 按真实收集滚动，不改变预算校验规则 |

内部函数名、类型和测试拆分由实施者决定。通常不需要改构建器；若拆分测试，只放在现有实验目录并纳入实际运行清单，不改根 Jest 配置。

**冻结：**全部生产源码与类型、kernel／facade／主入口／经济装配；Slice 0 adapter与coordinator；通用reset与Seal工具；现有 `observer.ts`、`singleShot.ts`、`controlRecord.ts`、`sendGate.ts`、`worldRead.ts`、`sample.ts`、`labConfig.ts`、示例JSON及 `probe.test.ts`；根package／lockfile／Rollup／TypeScript／Jest配置；Defense生产代码。构建器第三模式继续复用，不为一个 return 新增运行框架。

不新增持久字段、跨tick锁、观察凭证、模块注册表、健康token、重试／rearm或日志解析协议。main不直接send、不写控制槽、不代替single-shot判断资格。国库容量和生命周期预算、实验控制槽4096字节、maxSamples=32均不改变。

本轮默认只做离线修复。**禁止安装／启动游戏服务器、容器或数据库，禁止上传任一实验产物、武装或调用真实经济API，禁止读取正式凭证、`.secret.json`、既有世界配置或玩家Memory。**允许按现有lockfile安装开发依赖、构建、Node VM假端口测试和Git提交推送。

## 3. 先复现两个确定反例

### 3.1 基线调用链

起点 `requireLabModule()` 捕获模块解析异常或发现未导出loop后，打印 `lab-run-i-module-error` 并返回null。main却继续执行：

```text
observer = requireLabModule("observer")
→ observer 为 null，只跳过 observer.loop()
→ 当前 tick == targetTick
→ requireLabModule("single-shot")
→ 既有 single-shot 的资格、标记与读回全部通过
→ send spy 被调用一次
```

两个固定输入分别为：`require("observer")` 抛错；以及解析成功但返回 `{}` 或 `{loop: 1}`。其他条件全部合法：目标tick、正确合成身份、充足资源／费用／容量、合法武装的小控制记录。不能用未武装、错误tick或错误世界来遮住缺陷。

### 3.2 固定旧产物

起点下的证据目录：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i/offline/mainval/`

| 模块 | 相对该目录的路径 | 字节身份 |
| --- | --- | --- |
| 旧 main | `lab-run-i-main/main.js` | 7430字节；Git blob `26e842c7a1164752bc555eab928a05ff3114261c`；SHA-256 `44f624ccaa4a98da7b3441794fe2cd4b4b0c45b52f709c0039fd1ccc47a4d9c0` |
| observer | `lab-observer/observer.js` | 9160字节；SHA-256 `96721926941004522d0f77ce76e3648d57aec04bcaa5f07d58493903ce8f48a4` |
| single-shot | `lab-single-shot/single-shot.js` | 27697字节；SHA-256 `7730421dd7ef5d453387f03e5ad0eedec5b0b3c9d990bdeda805dd1213811391` |

先核对身份，再加载旧main及实际single-shot执行两个反例。正常对照使用真实observer。模块解析故障由VM的require边界注入，不编辑旧JS，不直接调用send替代整条路径。保存本轮真实输出，不抄审查方结果；不需要取得聊天ZIP。

基线预期：两个缺陷场景均出现observer模块错误，随后single-shot解析／调用各1次、send=1。正常场景send=1；observer.loop向外抛错时send=0。基线只用于证明旧行为，不把旧漏洞作为新产物的绿灯标准，不将旧main作为新交付入口。

## 4. 唯一实施责任：发送依赖观察装配，观察不依赖发送装配

### 4.1 正确控制流

保留现有读取tick、窗口及日志规则。窗口内流程应为：

```text
解析并验证 observer 模块
→ 不可用：保留明确的模块／阶段错误，立即结束本次 main.loop
→ 可用：调用 observer.loop()
→ 调用向外抛错：沿既有异常路径结束，不继续发送
→ 正常返回：仅当当前 tick == targetTick，才解析并调用 single-shot
→ single-shot 不可用：如实记录；已经完成的只读观察不撤销，后续窗口仍可观察
```

observer不可用时，**不仅send=0，还应没有single-shot的require与loop调用**。不触碰控制槽，不预先设置attempted，不伪造API返回码、发送边界或完成结论。错误日志可复用现有种类；不要为本次返回新增一个状态机。

只读调用正常返回 `undefined` 是合法的，不能要求返回true或新健康对象。保持窗口 `T−2..T+20`、模块加载零动作、目标tick先观察后发送、错过T不补调。目标tick失败后，T+1恢复观察也不能补发。

### 4.2 保证边界——不要扩大成观察健康协议

本轮证明的是**main可识别的模块装配失败与向外抛错会阻断后续发送**。现有observer为void接口，可能自己记录读取错误或截断；其正常返回不独立证明样本完整、外部console已收到或未来tick持续可用。

不修改observer接口，不在main扫描日志，不复制世界健康检查，不新增跨tick失败闩锁。真实实验仍须由外部Run I流程先取得只读基线、核对代码装载与日志通道，并在观察失败时停止。不得将这个局部return写成“所有观测故障都已自动安全处理”。

## 5. 必需验收：真实生成物、正确拒绝原因与合法对照

扩展现有 `runI.test.ts` 装配：由仓库构建器生成main／observer／single-shot，再加载实际生成的JS。注入只发生在模块解析或observer调用边界。成功模块优先转发真实产物loop；统计包装器只计数，不替实现阻断writer。

| 场景 | 必须观察到的结果 |
| --- | --- |
| **observer require抛错**；目标T、合法武装 | 模块错误指向observer及require；single-shot解析0、loop0、send0；控制槽内容与引用不变；无发送边界输出 |
| **observer导出不合法**；目标T、合法武装 | 至少覆盖缺loop与非函数loop；模块错误指向observer及loop-export；其余同上。null／undefined可作为同组补充，不另建机制 |
| **observer.loop向外抛错** | 已尝试调用observer；沿既有错误出口返回；single-shot不解析、不调用、send0。故障注入器不修改Memory、不取消武装 |
| **single-shot缺失或导出不合法** | 真实observer在T及后续窗口继续产生样本；send0、槽不变；不能把发送侧故障改成停止一切观察 |
| **正常三模块、合法武装** | 完整23tick内observer23次、single-shot1次、send1次；T内样本先于pre-call／boundary；同T重复调用也不增发；控制保护与4096字节约束保持 |
| **无武装、窗口外、错过T** | 保持既有语义：无武装时single-shot可被调用但自身拒发；窗口外两模块均不调用；错过T只观察不补发 |

正常23tick计数使用每tick一次调用的独立场景；同T重复调用使用另一场景，不把额外采样混进23次基准。两个固定故障各在T重复调用，再推进T+1；确认始终没有发送。可在T+1恢复真实observer，验证继续只读而不补发，无需永久锁。新建正常场景作为正向对照，不能沿用失败场景的损坏模块或控制记录。

统计实际require名称、observer调用、single-shot调用、send、日志阶段、控制槽前后值；至少一条“零发送”必须处于所有single-shot前置均可通过的合法场景，并以同样世界的正常模块对照证明。若只检查send0、却实际是被未武装或错tick拒绝，不算修复验收。

更新错误注释和现行说明，删除“两路完全独立、一路不可用不阻断另一路”的表述。**不改变两个叶子模块：本轮observer／single-shot构建结果继续与起点归档逐字节一致；main应按本轮实际hash与manifest核验，不能继续要求main等于旧hash。**

## 6. T01–T04 与状态结论

| 索引 | 完成标准 |
| --- | --- |
| **T01：基线与最小修复** | 两个旧产物反例真实复现；main在observer解析／导出失败时立即返回，保留合法void调用语义与现有发送保护 |
| **T02：失败路径产物测试** | 新生成main上的两项故障及向外throw均阻断single-shot解析／调用；错误来源明确、控制槽零变化；不是由其他门禁偶然拒绝 |
| **T03：单向依赖与回归** | 发送模块不可用时仍观察；正常23tick／重复目标tick／无武装／窗口外／错过不补调通过；叶子产物未变，生产／Slice／依赖／Defense冻结 |
| **T04：固定提交交付** | 新验证SHA、真实预算、原始输出、第二干净依赖环境复验、现行说明与线性push完成；离线结果与实机授权／NOT_RUN分开报告 |

T索引不是测试数量，不预填新的suites/tests，不要求为本轮人为增加固定数量的it。完成这四项即结束本轮限定开发，不再自行开启新的Prep或架构任务。

当前无实机授权时，报告应同时写：**“T01–T04离线修复通过／不通过”**与**“Engine Lab Run I实机：AUTHORIZATION_REQUIRED，NOT_RUN”**。未授权不等于本轮代码修复失败；离线通过也不等于S01–S06实机通过。

## 7. 固定提交验证与证据

证据根：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i-wiring-remediation-i/`

只需task、baseline、final、revalidation及一份短报告。保留完整命令、退出码、原始日志／Jest JSON、三产物／manifest／hash、故障矩阵、冻结diff和两个SHA。基线临时命令原件以文本归档；正式执行判定代码先提交后验证，不在验证结束后再首次加入新的校验脚本。

### 7.1 提交顺序

基线复现 → 最小实现与目标测试 → 按真实收集更新budget／预算脚本锚点 → 提交全部源码、测试、必要执行驱动及元数据 → 固定 `VALIDATION_HEAD` → 主验证与第二树 → 只追加证据和说明 → push。

不得降低校验强度、删除原测试或扩大预算上限掩盖回归。预算计数可以因新增测试真实增加，国库运行容量与探针字节上限不变。验证后若再改源码／测试／执行判定脚本，重新固定SHA并重跑受影响验证，不沿用旧通过声明。

### 7.2 主验证模板

以下为待执行模板，不是已经运行的结果。Bash／Windows等价执行均可；输出目录独立、命令退出码如实保留，不清空自己的证据目录。

```bash
set -euo pipefail
unset DEST
cd "$(git rev-parse --show-toplevel)"
START_HEAD=457b052e1c7300a91a8b85c6337cfbf244968ce0
FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
VALIDATION_HEAD="$(git rev-parse HEAD)"
OUT="$(node -p 'require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "treasury-run-i-wiring-"))')"
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
run existing-implementation-freeze git diff --exit-code "$START_HEAD" "$VALIDATION_HEAD" -- \
  test/mock/treasuryTerminalTransferPrototype.ts test/mock/treasuryTerminalTransferCoordinator.ts \
  test/lab/terminal-transfer/controlRecord.ts test/lab/terminal-transfer/singleShot.ts \
  test/lab/terminal-transfer/observer.ts test/lab/terminal-transfer/worldRead.ts \
  test/lab/terminal-transfer/sample.ts test/lab/terminal-transfer/sendGate.ts \
  test/lab/terminal-transfer/labConfig.ts test/lab/terminal-transfer/example.experiment.json \
  test/lab/terminal-transfer/probe.test.ts scripts/build-treasury-terminal-lab.mjs
# Defense生产文件已包含在production-freeze；测试回归仍单独运行。
git diff --name-status --no-renames "$START_HEAD" "$VALIDATION_HEAD" > "$OUT/changes-this-round.txt"
run typecheck npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run build npm run build
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/production-after-build.txt"
run lab-observer node scripts/build-treasury-terminal-lab.mjs --out "$OUT/lab-observer"
run lab-single-shot node scripts/build-treasury-terminal-lab.mjs --mode single-shot --out "$OUT/lab-single-shot"
run lab-main node scripts/build-treasury-terminal-lab.mjs --mode run-i-main --out "$OUT/lab-run-i-main"
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/production-after-lab-builds.txt"
cmp "$OUT/production-after-build.txt" "$OUT/production-after-lab-builds.txt"

LAB_FILES=(test/lab/terminal-transfer/probe.test.ts test/lab/terminal-transfer/runI.test.ts)
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
run jest-slice npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${SLICE_FILES[@]}" --json --outputFile="$OUT/jest-slice.json"
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
printf 'OFFLINE_VALIDATION_COMPLETE\n产物目录：%s\n' "$OUT"
```

若拆分了测试，在固定提交前将真实路径加入LAB_FILES，不漏跑或零收集。各组计数分列，不相加；budget自身重跑也单列。生产构建含时间信息，冻结以源码diff为准；上面cmp只证明实验构建没有覆盖这一次生成的生产bundle，不比较两次生产构建的hash。

### 7.3 第二树与Git交付

同一 `VALIDATION_HEAD` 建干净detached工作树，独立 `npm ci --no-audit --no-fund`；不junction／symlink／共享／复制主树node_modules，可复用下载缓存。保存安装输出、版本、lockfile hash、依赖解析路径，使用独立Jest cache与输出目录。

第二树只需复跑 **LAB（probe＋runI）和Slice 0**，独立核对两项observer故障的实际产物行为以及single-shot缺失时的观察对照。不要求再次全仓压力／budget长跑，不另造审查平台。reviewer应读本任务全文；没有独立reviewer则如实标同一执行者第二树复现，不把换目录自动称为独立审查。安装失败报告ENV_BLOCKED，不偷偷共享依赖。

最终报告列T01–T04、反例与合法对照的实际计数、原始文件路径、冻结结果、验证HEAD与最终交付HEAD、真实引擎NOT_RUN。原始数据、日志和SHA是依据，不以自报ACCEPT代替。

Git保持线性：不reset已推送历史、不rebase、不force push、不amend已推送commit、不合并main。push当前分支，核对远端；保存 `git diff --check`、`git status --short`、`git log --oneline --decorate -40`。验证后src/test/scripts及根配置应零差异；否则说明并重新验证。查询status／check-runs／Actions，无结果就标无CI证据。

## 8. 与真实实验的衔接——本文件不是运行授权

**当前编制时仍未取得明确实机授权。本轮离线修复完成后提交并停止，不安装服务器、不装载、不武装，不把AUTHORIZATION_REQUIRED改成ENGINE_LAB_PASS。**

真实实验仍是原来的 **Engine Lab Run I，S01–S06**，不是新一轮范围。原完整执行任务已在仓库：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i/task/task-brief.md`

用户后续明确授权时，沿该任务继续，使用包含本次修复的固定版本。未改的叶子产物继续复用；未来回填真实实验配置属于新的源码变化，须重新提交／构建／验证，不能手改JS沿用旧hash。历史字节冻结断言只证明当前合成配置下无回归，不能成为未来禁止合法配置变化的理由；也不能在本轮提前关闭这些断言。

以下文字仅供用户明确授权时使用，**不是已获得授权的记录**：

> 允许按 Engine Lab Run I，在本机新建、仅本机可访问的一次性 Screeps 实验环境，安装隔离依赖、启动必要服务、创建合成 bot 用户与两个 Terminal、装载实验探针，并最多调用一次发送 100H。允许保存证据后停止并清理本次新建环境。不接入正式服、PTR、既有私服或真实账号，不使用真实凭证，不接入国库生产 writer，不进行第二笔发送或故障注入。

授权后的原范围不变：官方真实runner／driver／processor，一次 `W1N57→W10N57` 的100H；新世界、合成bot、仅本机访问、独立存储；先取得至少两个不同tick的真实只读基线，暂停后回填配置、固定源码、重建并回读装载身份；外部确认日志通道可用后才武装；只观察T−2..T+20，不补发，运行阶段原180秒保护限值不变；异常或缺关键观察立即停止取证，保存证据后只清理本次环境。不能用本轮VM结果替代任何真实实验结论。

**本轮终点：修复main的已知错误路径并完成离线交付。不重开国库或探针架构，不自动执行真实实验。**

## 附录：本轮事实定位

以起点 `457b052e1c7300a91a8b85c6337cfbf244968ce0` 为准：

- 分支HEAD、`test/test-suite-budget.json`、Run I的 `offline/mainval/validation-head.txt`：本文编制时重新读取的三个版本依据。
- `test/lab/terminal-transfer/runIMain.ts`：observer为null仍继续进入目标tick分支，是本次修复对象。
- `test/lab/terminal-transfer/observer.ts`：void只读入口、内部错误与采样截断；本轮不将正常返回升级为数据健康证明。
- `test/lab/terminal-transfer/runI.test.ts`：既有三产物装配、正常窗口及叶子字节冻结，本轮在此加失败路径。
- Run I `offline/mainval/lab-run-i-main/manifest.json`、同目录三模块产物：旧main与固定叶子身份见§3.2。
- 原Run I任务及主报告：真实实验未获授权、未执行；本文件修复不改变该事实，也不重写历史证据。
