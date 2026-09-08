# Empire Treasury — Terminal Transfer Slice 0 · Remediation II
## 先归集后判全量、固定路线拒绝与 closing 投影验收

**用途：开发 Agent 直接实施、测试、commit、push。本文自包含，不需要读取聊天历史。**

编制日期：2026-09-08。状态：**待执行任务书，不是验收报告或部署许可。**

任务身份：**Terminal Transfer Slice 0 · Remediation II**；验收索引 **O01–O06**。承接本原型 Remediation I 的 N01–N08，不是旧内核的 Remediation II，不启动 Slice 1。

> 本轮只处理上一轮审查的三个剩余项：相关交易不能先按全量过滤；原型入口必须限定既定路线；补上原记录仍为 closing 时的国库余额与容量断言。单条在途、冻结费用、基本交易身份核对、延迟处理与恢复继续保留。生产内核不解冻，不再扩建证据工具。

## 1. 实施起点与继承结论

| 项目 | 编制时重新核对的值 |
| --- | --- |
| Repository | `ceyirelehe47/screeps-bot` |
| Branch | `refactor/empire-treasury-rearchitecture` |
| 本轮预期起点／上轮交付 HEAD | `b938a155bba8b861924a86883e47d4054bcaa158` |
| 上轮最终代码／测试验证 HEAD | `4ea56d0fa2033f3a1bde2e12f236c913970d1daf` |
| 上轮实现提交／预算引用锚点 | `9a83520b0109550bd68215f6f415b21a048a1da4` |
| 持续生产冻结基线 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 当前预算／上轮全仓提交结果 | **238 suites／1436 tests／1436 passed**；failed、pending、todo、runtime error 为 0 |
| 上轮定向报告 | M＋N：2／16；KEY：7／73；Treasury：34／590；Defense：11／118。集合重叠，不累加 |
| OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |
| 内核 | `Memory.runtime.treasuryCore`；schema v3；attempt `tk1_` |

上述测试数字是 Agent 提交的证据，不是本文编写方独立重跑全仓的结果。[R1–R3] 实施前 fetch；远端前移则核对增量、沿最新历史继续，不退回上述提交或覆盖他人的工作。

**保留已完成的成果：**完整描述严格相等、期望路线及交易双方来自持久请求、同 ID 副本一致性检查；按 action kind 读取 active 的单条在途；纯派生的冻结费用及 submit 前双层复验；M05/M07 延迟完成与配对恢复；核验驱动的脚本路径定位。此前国库内核的限定通过不因本轮补修撤回。

硬限制不变：active 64、recent ring 128、核心 JSON 字符预算 360,000、生命周期 8 份/tick、每次外部释放成对预扣 2 份且至多 4 次/tick、每记录至多 8 个消费者及 12 条 worstCase 腿、现有 fresh 限额。不得扩容、延长保留期限或放宽 validator 解决本轮问题。

## 2. 允许改动与禁止事项

主要修改 `test/mock/treasuryTerminalTransferPrototype.ts` 的对账判定顺序、`test/mock/treasuryTerminalTransferCoordinator.ts` 的固定路线入口，以及 M/N 相关测试。可新增 `src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts` 承载 O 反例，也可复用原测试文件；不为索引凑文件数或测试数。

必要的 OpenSpec、原始证据、预算 manifest 及现有预算脚本的锚点元数据可以更新。**默认不修改**已修好的 `scripts/verify-treasury-evidence.mjs`、通用 reset harness、Seal 风险核验 helper；正常回归使用它们，不再开发新的核验器、回放器或轨迹格式。

**禁止修改生产 kernel、facade、actionContracts、coverage、observation、生产 testHarness、生产装配、配置、依赖与 lockfile；Defense 生产行为继续冻结。**不把生产逻辑搬进测试豁免目录。不新增生产持久字段、schema 版本、永久证明、报价权威、持久锁或第二个队列。内部辅助类型交给实施者设计，本轮不固定新 schema。

场景仍为同一合成用户、同一 shard、**`W1N57 → W10N57`、100 H**，无 Power、无自动重试、无其他经济 writer 并发。C/D 房间只作为错误输入和噪声夹具，不变成新业务路线。

本轮不部署、不上传游戏代码、不启动任何真实游戏服务器，不运行 `npm run push`／`npm run local`，不调用真实 `terminal.send()`、`Game.market.deal()` 或其他经济 writer，不使用正式账号、PTR、现有私服、玩家 Memory 或凭证。默认测试与核验离线；允许按现有 lockfile 安装测试依赖，不更换依赖版本。

## 3. 工作 A：先归集相关事实，再判断是否唯一且全量

### 3.1 已确认的问题与原仓库基线

起点 `reconcile()` 的 `ownershipMatch()` 包含 `record.amount === payload.a`，只有满足该条件的交易 ID 才进入候选集合，随后才检查唯一性。[R4]

固定反例：已授权请求为 100 H；视图中同时存在不同游戏交易 ID 的 X=100、Y=60，两者的完整描述、期望路线、交易双方、资源和合法时间窗均相同。库存设置为正常完成一次100H后的值。当前函数会先过滤 Y，仅留下 X，返回 `observed_committed`。

上一轮移录函数探针已运行这个反例，但它不是完整仓库集成测试。**本轮先在起点上通过真实协调器／contract／facade／许可／Memory 路径复现，并保存原始结果。**最短做法：正常提交并由 fake 宿主完成100H，再通过既有公开交易视图注入同请求的另一条60H记录，调用 `service.settleUnknownOutcome({attemptId})`。这样库存、费用、tick等其他成功条件自然成立，拒绝不能靠旁支条件兜底。

这是“证据有歧义应拒绝”的测试，不宣称真实引擎正常执行一条请求必然产生两笔交易。宿主私有 pending/submits 只供测试断言，不供 reconciler 读取答案。

### 3.2 实施语义

**“属于本请求”与“满足全量完成条件”必须分开。**相关性先依据已授权请求的完整关联描述、期望路线、交易双方、资源、send/order类别及合法时间关系判定；**实际 amount 不是用来丢弃相关交易的条件。**相关 ID 的全部副本仍要先检查一致性，不能提前过滤掉矛盾镜像。

流程可以保持很小：从原有两个视图取得记录 → 按 ID 检查相关副本一致性并归并 → 确定本请求合法时间范围内的相关交易 ID 集合 → 唯一时才检查该记录是否恰好100H及其余全量条件。代码组织由实施者决定，不新增协议。

必须保持以下结果：

| 可见事实 | 期望结果 |
| --- | --- |
| 唯一正确100H记录；同 ID 的一致镜像或一致重复副本 | 可继续核验观察／库存并正常完成 |
| 只有一条相关60H记录 | `still_uncertain`，原责任保留 |
| 不同 ID 的相关100H＋60H，任意排列／分布于一个或两个视图 | `still_uncertain`，不能选择100H的一条 |
| 不同 ID 的两个相关100H，或同 ID 的100H／60H矛盾副本 | `still_uncertain`，保留原有拒绝 |
| 唯一正确100H＋不同完整关联键的无关60H记录 | 正常完成，不能因无关噪声一律拒绝 |
| 合法窗口内唯一正确100H＋本请求之前的无关历史记录 | 保留既有时间窗语义，不把全部历史当成当前重复执行 |

不把100＋60相加当作“完成160”；不挑一条“最像成功”的记录；不自动补发40；不报告 not_executed；不以TTL删除 unknown。部分结果只要求保守保留，不做通用部分结算。

### 3.3 验证重点

至少把100＋60的两种顺序、跨视图分布，以及正确唯一记录的恢复对照接到**注册 settle 入口**。拒绝后检查持久 phase/outcome、active 责任和 submit 总数不变，不能只直接调用 matcher 看字符串。正确对照须完成 committed → closing → 原 cleanup 退出。

保留 N01/N02 已有的完整描述、双方身份、错路线、同 ID 冲突、旧记录、读异常、市场记录和一致镜像回归。修的是筛选顺序，不重写已完成的归属协议。

## 4. 工作 B：固定路线是拒绝规则，不是默认值

起点协调器把 `sourceRoomName`／`targetRoomName` 当作可覆盖默认值；adapter只检查格式及源目标不同。现有“场景外目标”测试则依靠目标没有Terminal而拒绝，不能证明固定路线有效。[R5]

**本轮在测试专用业务入口处理这一条规则即可：**省略路线时使用 `W1N57 → W10N57`，显式传入同一路线可以接受；任一端点不同必须明确拒绝，不先准备、构建或接纳另一条路线。可保留可选字段并校验，也可移除路线覆盖能力；即使移除类型字段，运行时收到冲突路线也不能静默改成默认路线后宣告请求成功。

不修改通用 facade/kernel 的多房间能力，不新增路由权限系统。低层原型夹具可继续使用C/D构造反例，但所有声称验证本业务的正向路径从协调器进入。

**原仓库基线与修复用例：**安装A/B以及C/D四间受管辖、健康可见、Terminal存在且资源/容量充足的房间；没有任何在途工作，处于正常开放tick。通过协调器提交C→D（并补任一端点错误或反向路线的对照），应因**路线不在本场景范围**拒绝，而不是因关窗、单条在途、资源、冷却或结构缺失拒绝。验证没有新增active/许可、submit增量为0；同一健康场景的默认A→B随后仍能正常接纳并完成。

该入口反例在上一轮仅为源码推演，必须先实跑。若实际被其他规则阻断，记录原因并修正夹具使其他条件成立，不能把无关拒绝当作本项通过。

## 5. 工作 C：在 closing 尚未退出时验证国库不双扣

### 5.1 本项是补验，不预设生产有缺陷

现有M05/M07在结算后断言closing，随后先清理退出，再检查物理库存。它们没有验证closing期间的国库可用金额与风险调整后容量。[R6] 本项应先在现有实现上补测试；若通过，保持生产零改动，不为了制造基线红灯改坏代码。

沿现有业务入口和fake延迟处理，记录初始源H=1000、源energy=10000、目标H=0、目标物理空位F0及本请求冻结费用q。全量记录可见后，通过注册settle进入closing，**在调用会删除该记录的下一次生命周期推进之前**完成下面的检查：

| 检查点 | 必须观测到的事实（本夹具无其他承诺／预留） |
| --- | --- |
| 仍为closing | 同一attempt仍在active，outcome=committed；不是先删除记录再读账 |
| 源H查询 | observed=900；该次效果不再作为额外100占用扣减；committed=0、spendable=900 |
| 源energy查询 | observed=10000−q；committed=0、spendable=10000−q |
| 目标接收容量 | `riskAdjustedFreeCapacity(B,"terminal") = F0−100`，不是F0−200 |
| 读取前后 | active中的该记录仍为closing；submit总数不变；查询没有清理责任 |
| 后续原cleanup退出 | 上述金额／容量不因删除记录再增加一次；物理源−100H、−q energy、目标+100H，submit恰一次 |

**必须使用会消费占用的真实接口。**源余额通过现有 `service.query()`，限定单房间和terminal，关闭可选预计收入，**保留**流出／预留扣减；不得传 `subtractReservations:false` 绕过kernel占用。目标必须至少使用 `riskAdjustedFreeCapacity()`；仅检查 `strictProjectedFreeCapacity()` 或 `store.getFreeCapacity()` 不够，前者不承担同一风险占用扣减职责。[R7]

可采用以下现有查询口径，不新增接口：

```ts
service.query({
  resource: "H",                 // energy 另做同样检查
  rooms: ["W1N57"],
  locations: ["terminal"],
  allowProjected: false,
  allowIncoming: false,
  subtractOutgoing: true,
  subtractReservations: true,
  withhold: 0,
});
```

测试中使用既有零保留policy及完整健康承诺夹具；检查context/commitment有效、`authorizationSafe`和blockers，不能拿fail-closed返回的0冒充正确金额。账目可用不代表协调器允许新调拨：原工作仍closing时，业务单条在途仍应阻断B，这是两条独立规则。

### 5.2 时序与恢复对照

**unknown阶段仍允许保守占用。**提交后尚未处理时必须保留100H／q／100空位责任；即使物理效果后来已经出现，但尚未取得可信结算结论，也不能为了让数字好看提前释放。上述“不双扣”检查发生在全量效果已进入适用观察、注册settle已确定committed之后，不要求unknown阶段自行推断完成。

把同一个小型账目断言接入普通M05和M07的两种配对恢复场景（提交后结果写回前、已接受未处理）。保持真正的JSON重载、模块/registry/协调器重建及配对宿主状态。恢复后依靠持久事实和当前可见交易，不依赖旧闭包答案。不手改active、phase、invocationBoundary或结算结论，不先cleanup再断言。

若新断言暴露真实的内核/接口问题，保存最小集成失败及正常对照，标记 **ADAPTER_GAP**，完成其他无关项但不擅自解冻生产；不能删除断言、跳过用例或关闭扣减开关伪造通过。

## 6. O01–O06 与交付要求

| 索引 | 完成标准 |
| --- | --- |
| O01 | 同请求不同ID的100＋60不会在全量筛选前丢失；两种顺序／跨视图经注册settle保持unknown和责任，submit不增加 |
| O02 | 唯一全量正常退出；一致镜像去重；只有部分量、两个全量ID及同ID矛盾继续拒绝；无关部分记录不阻断正确唯一结果；既有归属回归保留 |
| O03 | 存在且资源充足的非许可路线在业务入口因路线拒绝，无新增active/许可/submit；默认及显式正确A→B正常完成 |
| O04 | 普通及两种配对恢复路径，在同attempt仍closing时实际核对源H/energy spendable和目标riskAdjustedFreeCapacity；退出前后不重复释放，unknown保守责任不被提前消除 |
| O05 | M/N既有单条在途、费用冻结与submit前guard、身份/版本和cwd回归保持；生产/配置/依赖/Defense零差异，无新增持久权威 |
| O06 | 固定SHA主验证、第二干净上下文定向复验及原始结果归档；预算/验证/交付HEAD分开；原型限定结论与真实引擎未实测边界分开 |

三类问题分开报告：A为已运行过函数级反例的实现缺口；B为待仓库确认的入口缺口；C为验收欠项，不能预先称生产故障。对A/B保留同一仓库用例的起点行为与修复后预期；这已经提供目标退化对照，**不要求再建设变异测试驱动**。不得以零收集、编译失败、所有请求全拒作为有效红/绿结果。

本轮证据根：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-slice-0-remediation-ii/`

保留任务副本、简短baseline、final、revalidation和一份主报告即可。不重复搬运旧轮证据。小型业务轨迹列出attempt/workKey、相关交易ID与amount、settle结果、closing前后查询数值、F0/q、submit次数及active是否退出；不为这些小场景另造1MB轨迹协议。

最终报告逐项列O01–O06与实际测试/断言位置，注明旧N04的声明由本轮补验。旧日志保留历史身份。源码或测试辅助改动后，adapter版本/semanticIdentity是否需要变化应按其既有语义契约处理；不得静默将旧payload或旧身份解释为更强证明。

## 7. 执行顺序、验证与Git纪律

读取本文件全文后直接实施，不等待再次批准。先核对远端与工作树，完成A/B原仓库基线和C新增断言；再作测试侧最小修复。优先修正现有函数/入口，不新建平级机制。

开发树定向通过后，提交全部执行性代码、测试和实际需要的验证脚本，再按真实收集滚动预算、固定 `VALIDATION_HEAD`。随后在干净工作树运行主验证；第二上下文同SHA独立worktree、依赖安装、缓存及输出，复跑O/M/N、KEY、Defense和既有核验驱动。实际独立reviewer优先；没有则明确“同执行者第二树复现”，不冒称独立审计。

### 7.1 主验证模板

新O文件名可调整，但须在固定提交前替换下面清单为实际路径。所有结果写仓库外，默认测试不联网。模板是执行命令，不是已运行记录。

```bash
set -euo pipefail
unset DEST
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
START_HEAD=b938a155bba8b861924a86883e47d4054bcaa158
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
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/bundle-sha256.txt"

SLICE_FILES=(
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts
)
for file in "${SLICE_FILES[@]}"; do test -f "$file"; done
run jest-slice0 npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${SLICE_FILES[@]}" --json --outputFile="$OUT/jest-slice0.json"
KEY_FILES=(
  "${SLICE_FILES[@]}"
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
run jest-full npx jest --config jest.config.cjs --runInBand \
  --json --outputFile="$OUT/jest-full.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-budget"
run budget node scripts/verify-jest-budget.mjs
run verify-evidence node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
  --validation-head "$VALIDATION_HEAD" --run-dir "$OUT" --fixture h18
mkdir -p "$OUT/foreign cwd"
(
  cd "$OUT/foreign cwd"
  run verify-outside node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
    --validation-head "$VALIDATION_HEAD" --run-dir "$OUT" --fixture h18
)
run diff-check git diff --check
printf '%s\n' "$(git rev-parse HEAD)" > "$OUT/head-after.txt"
test "$(git rev-parse HEAD)" = "$VALIDATION_HEAD"
git status --porcelain > "$OUT/status-after.txt"
test ! -s "$OUT/status-after.txt"
printf '产物目录：%s\n' "$OUT"
```

不硬凑1436；budget自带重跑单列，不覆盖主全仓JSON。第二树保存自己的命令、退出码、原始Jest JSON及O关键业务轨迹；无新改动时无需第二树再跑全部长压力。核验输入是run根下的`trace-key/`加`jest-key.json`，不是把trace子目录当run根。构建含时间/Git身份时，bundle hash用于追溯，源码冻结以diff为准。

### 7.2 提交与停止

验证后只追加非执行性日志、数据与说明。需要执行、改变夹具或决定PASS/FAIL的新脚本必须先提交再验证，不能以“在evidence目录”解释为不受版本边界约束。命令实录可作为文本归档；不重写历史失败，不把旧产物冒充新运行。

不reset已推送历史、不rebase、不force push、不amend已推送commit、不合并main。归档前后检查`git diff --check`、`git status --short`、`git log --oneline --decorate -40`；push当前分支并核对远端HEAD。查询status/checks/Actions，空结果标“无CI证据”。最终验证之后若改执行代码/测试，重新固定并运行受影响验证，不继续引用过期结果。

**完成即停止：**O01–O06如实交付，结束这份离线补修。不追加新路线、自动补货、真实引擎设施、永久审计或通用部分结算。若O04实测暴露生产缺陷，提交ADAPTER_GAP及反例，不擅自改生产；报告文字或低优先级外围问题不另行扩大本轮。

## 附录：固定定位依据

以下项目源码统一锁定 `b938a155bba8b861924a86883e47d4054bcaa158`；实施时核对实际行号。

- **[R1]** GitHub分支最新commit：本文编制时重新读取，仍为上述HEAD。
- **[R2]** `test/test-suite-budget.json`：238／1436，预算锚点`9a83520b0109550bd68215f6f415b21a048a1da4`。
- **[R3]** `openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-slice-0-remediation-i/final/validation-head.txt`：`4ea56d0fa2033f3a1bde2e12f236c913970d1daf`；该轮主报告、原始Jest结果保留Agent侧运行身份。
- **[R4]** `test/mock/treasuryTerminalTransferPrototype.ts`：`ownershipMatch`／groups／candidates／visible，当前blob `05a6a0e419c5957cb449fe3a6b9781a1c2494e1f`。相关性包含全量条件，是100＋60漏检点。
- **[R5]** `test/mock/treasuryTerminalTransferCoordinator.ts`：`requestTransfer`的默认路线覆盖；当前blob `8b7e085e852917d4060405e28e308e6a1fdac673`。
- **[R6]** `src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts`：M05/N04及两项M07；原测试先退出再核对宿主库存。`treasuryTerminalTransferSlice0RemediationI.test.ts`：已有N归属/费用/单条在途对照。
- **[R7]** `src/runtime/treasury/facade.ts`：`query`在`subtractReservations`开启时计入kernel占用；`riskAdjustedFreeCapacity`扣除kernel流入占用，`strictProjectedFreeCapacity`不是同一风险口径。本次重新读取该段；只读定位，不授权修改。
- 原N任务书：`treasury-terminal-transfer-slice-0-remediation-I-implementation.md`，完整归属与多ID要求、固定路线和closing检查由本轮落实。无需持有原附件才能执行本文件。
- 可选探针：`treasury-terminal-slice0-remediation-I-review-probes.zip`，仅为函数级定位参考；缺附件也直接按§3复现，不能替代仓库集成测试。
- 固定engine基准仍为`80977824199a596d174d392fd0cf8c458c21fcbd`，driver为`cf63d8adf902663e2ebddd7f8c5b7baa425dc928`。本轮不重新研究外部引擎；已有源码契约、fake行为与真实运行证据继续分开。
