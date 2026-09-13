# Compat CPU Recheck VIII · Build VII Engine Recheck · Agent 任务书

## 目标

本包已经包含完整执行实现和固定测试。Agent 不再写代码，只执行一次四点受控诊断，比较 Build Optimization VII 与已验收 CPU Recheck VI 的真实阶段成本，并闭合线上恢复。

本轮不是十二点正式兼容观察，也不是完整 Treasury 上线。性能改善不是采集通过条件；结果更低、更高、相同或证据不足都必须原样保存。

## 0. 权限与失败纪律

允许：

- 在固定 compat 基线上只修改 `src/runtime/treasuryCompatConfig.ts`；
- 创建一个 ON 提交和一个精确恢复默认 OFF 的提交；
- 在确认部署目标排他使用后执行一次候选 POST；
- 沿同一 run 目录和同一 `restore-attempt.json` 最多执行一次恢复 POST；
- 有界重试只读请求；
- 创建一个 refactor evidence 提交并普通推送两条分支。

禁止：

- 修改本包实现、测试、阈值或固定证据；
- 提高 `maxSampleCpu=2`，增加第五点，换窗口补跑或启动第二 run；
- 部署完整 refactor、执行 Terminal／market／console 注入或工具侧 Memory 写入；
- 删除动作锁或写入标记后重试 POST；
- amend、reset、rebase、force-push；
- 将源码恢复 OFF 冒充线上恢复；
- 将 `partial_cpu_budget` 冒充完整样本。

上传前失败：保存 stdout、stderr、exit 和工作树状态，停止且不上传。上传后失败：不得终止仍在安全收尾的恢复进程；等待它完成后再判断终态。

## 1. 固定身份

```text
repository  ceyirelehe47/screeps-bot
compat      compat/treasury-read-bridge-i
compat base 2d28a6f146fc81e5b87be7cf5b70648352557797
refactor    refactor/empire-treasury-rearchitecture
refactor base a9f4cc04d99c8a8fda11f9c7e980861953341f03
candidate generated blob 4f94acf1c06a60de9ca8ff2f0cdd2910cb6913be
server      https://screeps.com
account     forster / 634fe406347a7b69b28aeccb
branch      default
shard       shard1
rooms       E3N59, E4N58
resources   energy, H
old production commit 06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c
old module digest 84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf
```

前置证据：

- CPU Recheck VI 裁决：commit `04ca086…`，blob `d1be370…`；
- Build VII 离线验收：commit `a9f4cc…`，blob `f3e46ce…`。

工具会从真实 Git 对象库读取并核对这些原件。不得用旧包、旧绝对 tick 窗口或人工摘要替代。

## 2. 路径

解压到 Git 工作树外的新目录。保留旧包和旧证据，不覆盖已有 WORK。

```bash
PKG="D:/code/screeps/incoming/screeps-compat-cpu-recheck-VIII-2026-09-14"
REFACTOR="D:/code/screeps/screeps-bot"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
WORK="D:/code/screeps/compat-cpu-recheck-VIII-execution"
SECRET="$COMPAT/.secret.json"
test ! -e "$WORK" || exit 1
mkdir "$WORK" || exit 1
```

`PKG`、`WORK` 和仓库不得互相包含，也不得通过 symlink／junction 指向仓库内部。`SECRET` 只传文件路径，不打印、复制或入库。

## 3. 包、基线和离线门禁

分别执行并保存外层 stdout／stderr／exit：

```bash
node -e 'console.log(JSON.stringify(require(process.argv[1]).verifyPackage()))' "$PKG/tools/util.cjs"
node "$PKG/tools/check-baseline.cjs" --refactor "$REFACTOR" --compat "$COMPAT"
node "$PKG/tools/run-tests.cjs" --compat "$COMPAT" --out "$WORK/tool-tests"
node "$PKG/tools/build.cjs" --compat "$COMPAT" --out "$WORK/baseline-checks"
```

必须满足：

```text
固定工具测试                176/176
failed/skipped/todo/cancelled 0
仓库五份 Node specs         200/200
Jest                         195 suites / 685 tests
loader --check               通过
两套 tsc --noEmit            通过
Rollup build-only            通过
```

这些层级存在包含关系，不能相加。预热构建不用于上传；正式候选必须从新 ON 提交的干净 detached worktree 重新构建。

## 4. 线上前提

执行前真实确认：

- 没有其他 Agent、人、CI、IDE watcher 或自动部署会写 `default`；
- 旧 collector／guard／recovery 进程全部退出；
- 两仓本地与远端仍匹配固定基线，工作树和索引干净；
- 机器可持续运行到窗口后并完成恢复；
- 包目录和 run 目录不会在执行中被更新、删除或复制覆盖。

无法确认时止于离线阶段。`--exclusive-target` 和 `--prior-workers-stopped` 是事实确认，不是形式开关。

## 5. 唯一执行入口

```bash
node "$PKG/tools/observe.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" \
  --offline "$WORK/baseline-checks" --tests "$WORK/tool-tests" \
  --work "$WORK/live" --secret "$SECRET" \
  --execute --exclusive-target --prior-workers-stopped
```

只运行一次。窗口在所有慢速离线检查后绑定：

```text
S = ceil((freshTick + 150) / 100) × 100
points = S, S+100, S+200, S+300
```

上传前再次要求至少 100 tick 提前量。构建过慢、线上字节变化或窗口过期时停止，不自动重选窗口。

固定参数：

```text
maxSampleCpu 2
reserveCpu   5
minBucket    2000
maxLogBytes  16384
wall limit   45 minutes
recovery runtime 75 seconds
```

`partial_cpu_budget` 可作为诊断报告继续采集，但不计完整样本。坏 JSON、身份或顺序错误、重复冲突、通道失联、`fault_disabled`、`output_limited` 或已报告成本超过 5 CPU 会进入恢复。5 CPU 是外部事后中止线，不是新的采样预算。

## 6. 恢复边界

候选 POST 最多一次，恢复 POST 最多一次。所有角色共享：

```text
action.lock
upload-attempt.json
restore-attempt.json
```

恢复前核对账号、活动分支和当前模块字节；仍是本轮候选才允许写旧生产原件，已是原件则不 POST，第三方代码不覆盖。POST 超时不重发，只允许只读回读判断结果。

字节恢复后创建独立 `closureId`，采集 75 秒 shard1 console 和账号级 CPU。运行确认前后都须回读旧生产字节。该日志不是原观察的连续段，也不能补诊断点。

## 7. 失败后的固定收尾入口

只读对账，输出路径必须不存在：

```bash
node "$PKG/tools/reconcile.cjs" --compat "$COMPAT" \
  --run "$WORK/live/run" --secret "$SECRET" \
  --out "$WORK/reconcile-01.json"
```

仅在原进程已退出、部署仍排他、无遗留锁且恢复写额度未消耗时，才允许一次 operator 收尾：

```bash
node "$PKG/tools/recover.cjs" --compat "$COMPAT" \
  --run "$WORK/live/run" --secret "$SECRET" \
  --execute-recovery --exclusive-target --prior-workers-stopped
```

需要关闭本地配置时使用：

```bash
node "$PKG/tools/close-source.cjs" --compat "$COMPAT" --run "$WORK/live/run"
```

不得删除锁、标记或 operator 目录后重试。

## 8. 独立验证与比较

```bash
node "$PKG/tools/verify.cjs" --run "$WORK/live/run" \
  --out "$WORK/independent-verification.json"
node "$PKG/tools/compare.cjs" --run "$WORK/live/run" \
  --out "$WORK/build-comparison.json"
```

验证器从原始 console 帧重算报告，不信任 collector 摘要。比较文件必须区分：

- raw reports／diagnostic reports／complete samples；
- 首个准入样本与首次实际 reader 调用；
- `readerLoad`、`observationBuild`、`commitmentBuild`、`directRead` 和 prefix CPU；
- `calls=1` 的真实构建区间与 `calls=0` 的边界工作；
- commitment index 完整性、投影行数和完整样本判定；
- 最多 3 个后继尾部，末点尾部不可观测。

历史对照为 CPU VI：4 条诊断、0 条完整样本、3 次 observation 构建、3 次 commitment 构建。跨轮库存、任务数量和引擎状态未受控，因此不计算因果提速百分比。成本下降不是通过条件，证据不足时写 `insufficient_invocations`，不追加样本。

## 9. 归档与发布

确认所有进程退出、本地源码 OFF 后：

```bash
node "$PKG/tools/archive.cjs" --refactor "$REFACTOR" \
  --run "$WORK/live/run" --tests "$WORK/tool-tests" \
  --offline "$WORK/baseline-checks" --secret "$SECRET"
node "$PKG/tools/publish.cjs" --refactor "$REFACTOR" \
  --compat "$COMPAT" --check-only
```

归档位置：

```text
openspec/changes/empire-treasury-core-rewrite/evidence/
legacy-read-bridge-i/compat-cpu-recheck-viii
```

私有 `backup.json`、`candidate.json`、`session.json`、凭据和构建产物不得入库。stdout／stderr／TAP 以保留原字符串、bytes 和 SHA-256 的 JSON 包装归档。完整原生 `git diff --cached --check` 必须 exit 0，无例外。

创建唯一 evidence 提交并普通推送：

```bash
node "$PKG/tools/publish.cjs" --refactor "$REFACTOR" \
  --compat "$COMPAT" --out "$WORK/publish-receipt.json" --push
```

若只在提交／推送阶段失败，保留索引和原件，用新 out 路径续接；不得重跑线上实验、amend 或制造第二个 evidence 提交。

## 10. 回报与允许终态

回报：两条完整 HEAD、包指纹、176/176、200/200、195/685、绑定 tick、四个实际 tick、逐点阶段成本、raw／diagnostic／complete、commitment 调用和四行投影情况、候选／恢复写边界、恢复前后摘要、75 秒验证、原生 whitespace 结果和限制。

全部满足时允许：

```text
CPU_DIAGNOSTIC_CAPTURE_VERIFIED
BUILD_VIII_COMPARISON_RECORDED
RESTORED_BYTES_AND_RUNTIME_VERIFIED
```

同时保留，除非本轮原始证据确实支持相反结论：

```text
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
```

不允许直接报告：

```text
ONLINE_COMPAT_READ_OBSERVED
CPU_BUDGET_GAP_REPAIRED
TREASURY_PRODUCTION_READY
完整 Treasury 生产切换
```

若上传后发生恢复，必须如实写明一次候选写入和最多一次恢复写入，不能写成“未部署”或“无线上代码写入”。
