# Empire Treasury — Terminal Transfer Engine Lab Prep I · Remediation II
## 4 KiB JSON 字节预算、读写统一校验与产物级收尾

**用途：开发 Agent 直接实现、离线测试、commit、push。本文自包含，不依赖聊天、上一份任务书或审查 ZIP。**

编制日期：2026-09-08。状态：**待执行任务书，不是验收报告，不授权真实引擎运行。**

任务身份：**Terminal Transfer Engine Lab Prep I · Remediation II**；验收索引 **R01–R04**。承接上一轮 Q01–Q06。不是 Terminal Transfer Slice 0 · Remediation III，不启动国库重写或新的实验平台。

> 本轮只有一个责任：实验控制记录的完整 JSON，按 UTF-8 编码计算，不超过 **4096 字节**；读取、拟写入和发送前读回均消费这一约束。保留已通过的发送前标记确认、发送后失败不重发及编译配置交接。完成这个局部收尾即停止，不自动运行真实实验。

## 1. 起点与继承结论

| 项目 | 编制时重新核对的值 |
| --- | --- |
| Repository | `ceyirelehe47/screeps-bot` |
| Branch | `refactor/empire-treasury-rearchitecture` |
| 预期起点／上一轮交付 HEAD | `87507f42b1302e6f0e5916d9dfb5c3cca9d94790` |
| 上一轮最终代码／测试验证 HEAD | `c8a6d53271b269c25c2b83c3f05cecea41433dab` |
| 上一轮实现／预算引用锚点 | `b6ab29a6f0fb1ea5855e150db883df382bd2acbf` |
| 当前预算 target／已提交全仓结果 | **240 suites／1460 tests／1460 passed**；failed、pending、todo、runtime error 均为 0 |
| 上轮定向结果 | LAB 1／17；KEY 9／97；Treasury 35／597；Defense 11／118，集合有重叠，不累加 |
| 持续生产冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 当前内核 | `Memory.runtime.treasuryCore`，schema v3，attempt `tk1_` |
| 本轮允许涉及的 Memory | 仅实验独立槽 `Memory.__labTerminalTransferProbe` |
| OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |

以上测试数字属于上一轮归档证据，不是本轮结果，也不是本文编制方本次重跑。现有 budget 的 `baseline.tests` 为 1454，`target.tests` 为 1460；报告本轮起始验证规模时使用 target，不把两者混写。实施前 fetch 核对远端；分支前移则检查增量并继续线性开发，不 reset 到本表 SHA、不覆盖他人工作。

**上一轮应保留的有效成果：**发送前写入必须返回明确结果，并重新读取控制槽核对本次实验 ID、attemptedTick、attempted、资格与停止事实；setter 抛错、静默丢写、读回异常或不匹配时零发送。发送后的结果更新失败保留 attempted，不再次调用。配置已经明确为编译时 `labConfig.ts`，JSON 只是文档示例，Memory 不覆盖编译配置。

P01 注册 settle 两种排列、P02 独立依赖安装，以及 Slice 0 的完整交易归属、单条在途、冻结费用、延迟确认和 closing 不双扣继续保留限定通过。本轮不重做它们。

**本轮保留项的性质：**当前单 run 控制槽仍然有固定字符上限，不是无限增长；尚未兑现的是声明的 4 KiB 字节预算及读取侧检查。没有确认需要修改生产内核的新缺陷，真实引擎仍为 **NOT_RUN**。

## 2. 允许修改范围与停止边界

优先仅修改 `test/lab/terminal-transfer/controlRecord.ts`、同目录 `probe.test.ts`，以及现行说明中错误的“4KiB 字符口径”。确需一个小型纯字节计数函数，可以放在原文件或同目录；内部函数名、返回类型和文件拆分自行决定，不固定新 schema。

`singleShot.ts` 只允许为既有失败结果接线或更新说明作必要的小改动；其“写入成功 → 真实读回确认 → send”的顺序不得改变。构建器原则上保持原行为，仍使用现有依赖和已有两个独立入口。

**冻结：**全部生产源码与类型、kernel、facade、actionContracts、coverage、observation、生产 testHarness、主入口、经济装配；Slice 0 adapter/coordinator；通用 reset harness、Seal 核验工具；observer/worldRead/sample/sendGate 的既有行为；根 package.json、lockfile、Rollup／TypeScript／Jest 配置与 Defense 生产代码。编译配置继续使用现有合成值，不改路线、额度、目标 tick 或实验身份来掩盖失败。

核心 active 64、recent ring 128、核心 JSON 360,000 字符、生命周期 8 份／tick 等既有上限不变。**本轮的 4096 UTF-8 字节约束只定义实验控制记录的本地预算，不改国库的字符预算，也不声称它等于游戏引擎对整个 Memory 的内部计量方式。**

禁止新增控制槽、多 run 历史、永久证明、动态配置、重试／rearm、诊断队列或通用序列化框架。不扩大上限，不用“把文档改成 4096 字符”替代实现。

**不执行：**服务器／容器／数据库启动、游戏代码上传、`npm run push`、`npm run local`、真实 terminal.send 或市场调用、CPU 超限／driver 故障注入。不得读取正式凭证、`.secret.json`、PTR／现有私服配置或玩家 Memory。允许既有 lockfile 的开发依赖安装、本地构建和假 Game／Memory／Terminal 测试。

## 3. 固定基线反例：先复现，后修改

### 3.1 基线定位与产物身份

当前 `writeControlRecord()` 用 `JSON.stringify(record).length > 4096` 判断超限；`readControlRecord()` 只做存在性与形状检查，未检查大小。`confirmAttemptedMark()` 会调用该读取函数，因此读回健康判定也没有完整消费大小约束。

固定旧产物位于起点提交：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-prep-i-remediation-i/final/lab-single-shot/single-shot.js`

身份：**24,496 字节**；Git blob `447970f3f3a165a25a71d3c481e47d416e030168`；SHA-256 `49960ef8d5a147adeb49d6a36ba9df5b56cfd79028918e9be50d522d46f083ca`。

先核对身份，再在隔离 VM 假世界加载它。不要将旧产物上传或作为新的 writer 交付。基线输出须由实施者本轮实跑取得，不能抄审查结论。

### 3.2 B1：非 ASCII 结果记录超过 4 KiB 仍写入

正常目标 tick、合成身份、资源／费用／容量与初始小控制记录全部合法。send spy 进入时确认 attempted 已存在，然后抛出 `new Error("错".repeat(2048))`；spy 不更新库存、冷却或交易视图。

旧产物预标记成功、send 恰一次；结果 JSON 的字符长度低于 4096，但 UTF-8 字节数大于 4096，仍被写入控制槽。上一轮独立探针观察值为 `.length=2200`、UTF-8 字节数 `6296`；**本轮需记录自己实际生成的 JSON 和测量结果，不把这两个数硬编码成唯一验收条件。**

修复后：仍允许这次合法 send，**超限结果更新被拒绝**，此前匹配的 attempted 标记保留且不超 4096 字节。同步异常在外部日志中如实记录；不得将异常改成成功、删除 attempted 或重新发送。

### 3.3 B2：受支持字段组成的超限记录仍被读取为健康

构造普通 JSON 记录：使用当前合成 experimentId，`armed=true`、`attempted=true`、合法 attemptedTick、`stopped=true`，`syncResult={ok:false,error:"x".repeat(5000)}`。全部字段均受现有形状支持，无 note、extra 或循环引用。

先独立证明完整 JSON 的 UTF-8 字节数大于 4096。旧 `readControlRecord()` 仍返回 ok。修复后必须返回非健康结果，且读取零写，不删除、不裁剪、不重置原记录。

这项可以在旧源码的直接读取入口复现；产物 VM 如需临时暴露内部函数，仅在审查副本中做明确标注，不把该结果冒称公开 loop 的发送反例。**B2 证明的是读取契约缺口，不是超长 stopped 记录能再次发送。**

保留一个字段相同、短 error 的合法记录对照，证明读取没有被整体禁用。B1/B2 一份小型日志即可，不新建证据平台。历史反例只验证旧实现的缺口；新实现正式验收使用正确预期。

## 4. 唯一大小语义：完整 JSON 的 UTF-8 字节数

### 4.1 明确定义

度量对象为实验控制槽**值本身**的完整 `JSON.stringify(record)` 结果，按 UTF-8 编码后的字节数；包括所有键名、标点、转义和结果文本，不仅计算 error 字段。外层 Memory 键名和其他 Memory 内容不计入这个单记录预算。

- **≤4096 字节：**只表示大小合格；仍须通过原有形状、身份、时点和发送条件。
- **>4096 字节：**不健康／拒写，不进入发送前确认成功分支。
- 序列化无法形成合法可用字符串或计量失败：明确失败，不当作 0 字节。

读取、拟写入和发送前读回使用同一个实现口径。不要让 reader 用字符、writer 用字节；不要只替换常量名称或日志单位。

### 4.2 实现要求

计数针对**实际序列化后的字符串**，不能在原始字段上估算后忽略 JSON 转义。正确处理 ASCII、中文、双字节字符、代理对字符以及引号／反斜杠／控制字符转义。计数的 JSON 字符串应当也是后续解析后写入槽的那个字符串，避免测量一份、写入另一份。

实验运行产物不得依赖 Node 专属 Buffer、fs、process 或隐含的 TextEncoder 全局；沿现有依赖用小型纯 JavaScript 实现即可。**Node 测试可以使用 `Buffer.byteLength(serialized, "utf8")` 作为独立期望值，但不能让被测 helper 同时生成 expected。**不新增 npm 依赖。

更新大小字段／日志时明确写 bytes；保留 characters 供诊断可以，但不得称其为字节。超限提前退出可以只报告“超过上限”，不把尚未完整计数的值声称为精确总字节数。

### 4.3 读取、写入和读回的责任

**读取：**已有形状检查与大小检查都通过才返回 ok。输入超限时零写；不会自动修复、缩短、迁移、初始化或重新武装。拒绝读取不等于已经回收现存超限数据，报告不得作此声明。

**写入：**序列化、大小校验通过后才尝试控制槽赋值；超限或序列化失败不触发 setter，槽内旧值不变。保持既有明确写结果；赋值未抛错仍不是读回确认，更不是 driver 持久化。

**发送前读回：**继续重新从槽读取，消费包含大小校验的健康判定，再核对本次 expected attempted 状态。不能通过缓存引用或仅检查 attempted=true 绕过读取约束。

**结果写失败：**采用最小方案——整次超限结果更新拒写，保留小而匹配的 attempted 标记。不要新增分块、截断协议、溢出槽或异步结果补写。不得把未保存的 stopped 描述为已持久化。

## 5. 必需测试：边界独立计量，行为执行真实产物

沿用现有构建装配，先生成 observer 和 single-shot，再加载实际 JS 的 loop。不要只 mock 写入结果或仅测未被产物使用的计数函数。无需人为凑固定 it 数量。

### 5.1 源码入口的读写边界矩阵

用现有受支持字段构造合法**已结束记录**，在 error 中动态补齐文本，使完整 JSON 分别为 **4095、4096、4097 UTF-8 字节**。只测读写时使用已结束记录，避免把“未尝试记录随后还需要增加标记”的空间问题混进边界结果。

对每种边界至少覆盖纯 ASCII 与含非 ASCII 的两类记录：4095／4096 的合法值正常读写；4097 拒写且旧槽不变，直接预置该值后读取不健康且零写。精确 4096 必须有合法成功对照，不能将上限错误实现为 `>=4096` 全拒。

计数辅助的紧凑矩阵再覆盖中文、双字节字符、emoji、引号／反斜杠／换行；可将孤立代理项也放进 JSON 序列化后的对照，验证的是实际字符串，不引入任意对象序列化协议。短合法 Unicode error 不得被一律拒绝。

### 5.2 实际生成物的三个行为场景

| 场景 | 必须断言 |
| --- | --- |
| **非 ASCII 结果超限（B1）** | 在 send 入口内观察到匹配 attempted；同步抛错如实输出；结果更新因字节超限被拒；槽仅保留原 attempted，字节数≤4096；同 tick 两次、下一 tick 及保留该槽的新 VM 均累计 send=1 |
| **受支持字段超限的读取（B2）** | 直接 reader 返回不健康；生成物 loop 在控制读取阶段拒绝而不是仅因 already_stopped 拒绝；零 send、零控制槽写，原输入内容不变；短合法对照继续健康 |
| **发送前读回超限** | 首次入口读取和预标记候选合法；故障只发生在写后读回阶段，返回使用相同已知字段、ID/tick/attempted均匹配但 error 超限的对象；按不健康读回拒绝，零 send、零发送边界日志 |

最后一项使用既有控制槽故障装配模拟读回，明确记录阶段；该合成错值可以用来验证拒绝，但不能被当作实现已经正确发布的安全事实。故障输入不含未知键，避免又只验证到字段白名单。无需扩展到任意恶意 getter／递归模型。

B1 的保留控制事实重载对照至少一次在**相同目标 tick 的新 VM**执行，避免被错过 tick 门禁掩盖；再检查后续 tick。send=1 只代表假端口调用，不是真实转运发生。

### 5.3 已有保证仅回归，不重新设计

Q01–Q03 的 setter 抛错、静默丢写、读回异常／不匹配在发送前仍为零调用；正常小记录的 OK／非 OK／throw 仍只调用一次；结果更新异常／丢写不撤销 attempted；observer 加载及多 tick 零发送、零 Memory 写。现有 Slice 0／P01／KEY／Defense 正常回归。

在至少一组新 VM 产物测试中不给 Buffer／TextEncoder，证明新的容量路径不依赖 Node 注入；独立期望测量留在 VM 外。假 send 不自行修改库存或交易记录。

输出紧凑结果表：场景、字符数、独立 UTF-8 字节数、读／写结果、拒绝阶段、累计 send 数、最终槽大小及 attempted。正常小记录和4096边界必须与拒绝场景一起出现，不能靠所有请求一律拒绝取得通过。

## 6. R01–R04 验收

| 索引 | 完成标准 |
| --- | --- |
| **R01** | 固定旧产物 B1 与旧读取入口 B2 实跑复现，有合法对照和身份记录；新行为不再接受对应超限结果／超限读取 |
| **R02** | 完整 JSON 的 UTF-8 字节计量在读取、写入、读回一致；4095／4096通过、4097拒绝；已知字段、Unicode与转义对照真实覆盖，期望值独立计算 |
| **R03** | 实际生成 single-shot 验证非 ASCII 结果超限不损坏 attempted、不重发，超限读回阻断发送；observer和原Q流程不退化，无Node专属编码依赖 |
| **R04** | 现行说明单位准确；生产／Slice／依赖／Defense冻结；固定新SHA、真实budget与原始结果、第二干净依赖环境复验；commit/push与NOT_RUN边界保持 |

本轮只结束这一项大小约束。不得重开 Q 的发送时序、配置通道、P01/P02 交接或 Slice 0 业务逻辑。与本任务无关的建议单列，不自行扩成新实现工作。

## 7. 固定提交、验证与归档

### 7.1 提交和证据范围

先在旧版本复现，然后作最小改动并跑目标测试。全部实际执行的源码、正式测试和必要驱动先提交；按真实测试收集更新现有 budget manifest／预算脚本锚点，固定新的 `VALIDATION_HEAD`。不预填测试通过数，不复用旧 ACCEPT 作为本轮结论。

证据根：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-prep-i-remediation-ii/`

只需 task、baseline、final、revalidation 和一份短主报告。复用原命令记录、日志、Jest JSON与manifest，不建设新追踪格式。基线脚本或临时命令原件可作文本归档；正式判定代码不能在最终验证后才首次入库。构建生成物按实际输入SHA与hash归档，和后置手写驱动区别处理。

现行 `terminal-transfer-engine-lab-prep-i.md` 及源码注释改为“完整 JSON 的 UTF-8 字节数≤4096”；不改写历史报告让它假装当时已经采用字节口径。保留“当前脚本内写入／读回≠driver持久化”的限制。

### 7.2 主验证模板

以下是待执行命令，不是已完成记录。采用 Bash；Windows须保证Node与shell使用同一真实临时目录。输出目录建立后不整目录删除，不让驱动清掉自己的日志。

```bash
set -euo pipefail
unset DEST
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
START_HEAD=87507f42b1302e6f0e5916d9dfb5c3cca9d94790
FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
VALIDATION_HEAD="$(git rev-parse HEAD)"
OUT="$(node -p 'require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "treasury-lab-r2-"))')"
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

若新增了拆分测试，在固定提交前将实际路径加入 LAB_FILES；不能漏跑或以零收集通过。LAB位于test目录，不在Treasury定向范围中；报告分别列LAB、KEY、Treasury、Defense、全仓和budget重跑，不累加重叠数。

### 7.3 第二树及提交纪律

同一新的 `VALIDATION_HEAD` 上建立干净 detached worktree，执行独立 `npm ci --no-audit --no-fund`；不得junction、symlink、共享或复制另一树的node_modules，可复用npm下载缓存。记录Node/npm版本、安装原始输出与退出码、lockfile hash及依赖实际解析路径，使用独立Jest cache和输出目录。

reviewer读取本文全文后，复跑 **LAB＋KEY＋Defense**，其中KEY已包含Slice 0；无需第二树再跑全部长压力或budget全仓重跑。重点用独立Node字节计算核对4096/4097、非ASCII结果拒写、受支持字段超限读取及保留attempted不重发。没有独立reviewer，如实标同一执行者第二树复现；安装失败留ENV_BLOCKED，不退回共享安装并声称独立完成。

保存实际生成物和manifest、冻结diff、原始Jest日志／JSON、边界矩阵及命令退出码；不复制主树结果充当第二树。源码与原始数据用于判定，reviewer的PASS摘要不能取代它们。

验证后只能追加日志、数据、说明及该次构建产物。修改源码、测试或判定驱动后，重新固定SHA并验证受影响范围。交付前核对验证SHA到分支HEAD的src/test/scripts及根配置差异。

不reset已推送历史、不rebase、不force push、不amend已推送commit、不合并main。按实现／测试、预算、证据的可追溯边界提交；push当前分支，核对远端HEAD。保存 `git diff --check`、`git status --short`、`git log --oneline --decorate -40`，查询commit status／check-runs／Actions；没有结果就标无CI证据。

**最终停止：**交付R01–R04及局部字节约束修复；生产内核与Slice 0不解冻，两个探针均不上传，真实引擎保持NOT_RUN。本轮完成不自动授予实验运行或部署许可。

## 附录：固定定位

下列事实均以起点 `87507f42b1302e6f0e5916d9dfb5c3cca9d94790` 为准；实施时核对实际行号。

- 分支HEAD、`test/test-suite-budget.json`、`evidence/terminal-transfer-engine-lab-prep-i-remediation-i/final/validation-head.txt`：本文编制时重新读取，三种版本身份见§1。
- `test/lab/terminal-transfer/controlRecord.ts`：`CONTROL_MAX_CHARACTERS=4096`、writer使用serialized.length、reader缺大小检查；`confirmAttemptedMark`已有真实读回，不重写其身份语义。
- `test/lab/terminal-transfer/singleShot.ts`：已修复的写入／确认／send顺序与attempted结果更新来源，继续保留。
- `test/lab/terminal-transfer/probe.test.ts`：已有实际构建产物装配、Q故障矩阵和ASCII超长诊断测试，本轮补Unicode与已知字段大小边界。
- `terminal-transfer-engine-lab-prep-i.md`：编译配置交接已完成，只更新本轮大小单位与现行状态。
- 上轮主报告与归档产物：提供历史运行来源，不替代本轮真实验证；基线完整路径与hash见§3.1。

内部schema与编码辅助的实现细节由实施者决定；本文只固定必须共享的大小语义、失败行为和验收条件。
