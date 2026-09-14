# Source Manifest Remediation + Subphase Online X v2 · Agent 任务书

## 目标

本修正版包已经包含全部修复、在线执行、恢复、验证、归档和发布实现。它修复旧包的 porcelain 解析与遗漏 provenance 两个确定性缺陷，并可无损接续当前未推送的精确四路径 partial remediation 提交。Agent 不再设计或修改代码，而是在一轮中闭合以下里程碑：

```text
来源门禁修复
→ 完整离线验证
→ IX 四点在线子阶段归因
→ 旧生产恢复与 75 秒运行确认
→ 原始证据重验与归因裁决
→ 唯一 evidence 提交与双分支普通推送
```

本轮不是十二点正式兼容观察，也不是完整 Treasury 上线。即使首次出现完整业务样本，也只表示本轮有限诊断取得进展。

## 0. 权限与失败纪律

允许：

- 若 compat 本地仍在根基线，创建一个固定的五路径 source-manifest remediation 提交；
- 若 compat 本地是旧包产生且未推送的精确四路径 partial remediation，保留该提交并追加一个只修改 provenance 的 completion 提交；
- remediation 后仅修改 `src/runtime/treasuryCompatConfig.ts`，创建一个 ON 提交和一个精确 OFF 提交；
- 在真实确认部署目标排他使用后，最多一次候选 POST；
- 沿同一 run 目录、动作锁和持久标记，最多一次恢复 POST；
- 有界重试只读请求；
- 创建一个 refactor evidence 提交并普通推送两条分支。

禁止：

- 现场修改本包、测试、阈值、窗口、来源身份或归因算法；
- 提高 `maxSampleCpu=2`，追加第五点、重选第二窗口或启动第二个 run；
- 跳过 remediation，或把旧生成器的成功输出当成完整门禁；
- 部署完整 refactor、执行 Terminal／market／console 注入或工具侧业务 Memory 写入；
- 删除锁或写入标记后重试 POST；
- amend、reset、rebase、force-push；本包不要求也不授权回退当前 partial remediation；
- 把本地 OFF 提交冒充线上恢复；
- 将 `partial_cpu_budget`、index complete 或空 rows 冒充完整样本。

上传前失败：保存 stdout、stderr、exit 和 Git 状态后停止，绝不上传。上传后失败：不得杀死仍在安全收尾的恢复进程；等待其完成，再按固定只读对账和受限恢复入口处理。

## 1. 固定身份

```text
repository       ceyirelehe47/screeps-bot
compat branch    compat/treasury-read-bridge-i
compat root      57987cda22553fcdc842e8d4c72a98b6e94e00fb
refactor branch  refactor/empire-treasury-rearchitecture
refactor root    73726cd44267b0f583f5d08890233ad67a5e803a
IX generated core blob 62752b09e3828e67a9000aeffcda0b2436368bf1
server           https://screeps.com
account          forster / 634fe406347a7b69b28aeccb
branch           default
shard            shard1
rooms            E3N59, E4N58
resources        energy, H
old production   06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c
old module digest 84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf
```

工具会从 refactor Git 对象库核对：

```text
CPU Recheck VIII FINAL-VERIFICATION
commit 77b82bff48e9f32a3ac035cf5e0888e1329b1046
blob   a7938d71511d03226bf0945d284bce7bcd0f0ff5

Subphase Attribution IX FINAL-VERIFICATION
commit 73726cd44267b0f583f5d08890233ad67a5e803a
blob   adb03f9fb65561bd20b28b0d7a9220fdadc35537
```

## 2. 路径

解压到两个 Git 工作树之外的新目录。旧包、旧 WORK 和旧证据不得覆盖。

```bash
PKG="D:/code/screeps/incoming/screeps-compat-subphase-online-X-v2-2026-09-14"
REFACTOR="D:/code/screeps/screeps-bot"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
WORK="D:/code/screeps/compat-subphase-online-X-v2-execution"
SECRET="$COMPAT/.secret.json"

test ! -e "$WORK" || exit 1
mkdir "$WORK" || exit 1
```

`PKG`、`WORK` 与仓库不得互相包含，也不得经 symlink／junction 指向仓库内部。`SECRET` 只传路径，不打印、复制或入库。

## 3. 包、根基线与固定工具测试

分别保存每条命令的 stdout、stderr 和 exit：

```bash
node -e 'console.log(JSON.stringify(require(process.argv[1]).verifyPackage()))' "$PKG/tools/util.cjs"
node "$PKG/tools/check-baseline.cjs" --refactor "$REFACTOR" --compat "$COMPAT"
node "$PKG/tools/run-tests.cjs" --compat "$COMPAT" --out "$WORK/tool-tests"
```

必须满足：

```text
PACKAGE_INTEGRITY_VERIFIED
SUBPHASE_X_BASELINES_VERIFIED
compatStartMode = root / partial / complete 之一
固定工具测试以 references/test-contract.json 的固定总数全部通过
failed / skipped / todo / cancelled 全部 0
```

当前 Agent 现场预期为 `compatStartMode=partial`。工具会验证该本地提交的唯一父提交、四路径 scope 和全部 payload 字节；不按短 SHA 放行，也不采用未知本地提交。

## 4. 来源清单与生成门禁修复

执行唯一固定 remediation：

```bash
node "$PKG/tools/remediate.cjs" \
  --compat "$COMPAT" --out "$WORK/remediation"
```

它根据已验证起点执行两种等价路径之一：

```text
fresh root:
  创建一个五路径提交
  fix(compat): verify every source manifest output

exact partial continuation:
  保留既有四路径提交
  追加一个仅补 provenance 的提交
  fix(compat): complete source manifest remediation
```

最终 remediation tree 允许改变的路径恰好为：

```text
docs/treasury-compat-loader-optimization.json
docs/treasury-compat-source-manifest.json
docs/treasury-compat-source-manifest-remediation-x.md
scripts/build-treasury-compat-loader.cjs
test/treasury-compat/attribution.spec.cjs
```

旧包当前 partial 提交不得 reset、amend 或重写。新工具使用 `git status --porcelain=v1 -z` 原始字节解析路径，不再经过 `.trim()`；随后把生成器实际重生成的 loader optimization provenance 纳入固定 payload 与 LOCK。

修复内容：

- 更新 runtime、real-readers、helpers 三项陈旧 bytes／SHA-256／Git blob；
- 同步提交重生成后的 `docs/treasury-compat-loader-optimization.json`；
- source manifest 输出集合固定为 13 项；
- `--check` 校验每一项 listed output；
- stale、missing、duplicate、changed output 的负向测试必须失败。

此时**不要推送**。远端 compat 仍必须停在根基线。

## 5. Remediation 后完整离线门禁

```bash
node "$PKG/tools/build.cjs" \
  --compat "$COMPAT" --out "$WORK/baseline-checks"
```

必须满足：

```text
SUBPHASE_X_OFFLINE_VERIFIED
真实仓库六份 Node specs   246/246
Jest                       195 suites / 685 tests
loader --check             all-listed-outputs 通过
两套 tsc --noEmit          通过
Rollup build-only          通过
```

这些层级存在包含关系，不相加。预热 build-only 产物不得用于上传；候选必须从新的 ON 提交的干净 detached worktree 重新构建。

## 6. 上线前人工事实确认

继续之前真实确认：

- 没有其他 Agent、人、CI、IDE watcher 或自动部署会写 `default`；
- 旧 collector／guard／recovery 进程全部退出；
- refactor 仍在固定根基线；compat 本地为已验证的最终 remediation source head（fresh 模式一提交或 continuation 模式两提交），远端仍是 compat 根基线；
- 两仓工作树和索引干净；
- 机器可以持续运行到窗口后，并完成恢复与 75 秒运行确认；
- 包和 run 目录不会在执行中被更新、删除或覆盖。

无法确认时止于离线阶段。`--exclusive-target` 与 `--prior-workers-stopped` 是事实确认，不是形式开关。

## 7. 唯一在线执行入口

```bash
node "$PKG/tools/observe.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" \
  --offline "$WORK/baseline-checks" --tests "$WORK/tool-tests" \
  --work "$WORK/live" --secret "$SECRET" \
  --execute --exclusive-target --prior-workers-stopped
```

只运行一次。窗口在所有慢速离线检查之后绑定：

```text
S = ceil((freshTick + 150) / 100) × 100
points = S, S+100, S+200, S+300
```

上传前再次要求至少 100 tick 提前量。窗口失效、线上字节变化或构建太慢时停止，不自动换窗口。

固定参数：

```text
maxSampleCpu          2
reserveCpu            5
minBucket             2000
maxLogBytes           16384
wall limit            45 minutes
recovery runtime      75 seconds
external observed stop 5 CPU
```

5 CPU 是外部事后安全中止线，不是采样预算，也不是硬实时抢占保证。

## 8. 九子阶段与工作量口径

每份可归因报告最多包含：

```text
observationSetup
observationRooms
observationFinalize
observationView
commitmentSetup
commitmentTasks
commitmentReservations
commitmentFinalize
projectionRows
```

完整样本固定 12 次边界。子阶段嵌套在原父阶段内，**不得与父阶段相加**。测量开销不扣除；不按 task、reservation、资源键或 query 逐项采样。

primitive work counters 用于解释工作组成，包括 task、pending、健康检查、route candidate、owner evaluation、bucket、计划／完成投影行和 query 数量。它们不是 CPU 权重。

`partial_cpu_budget` 可以作为归因证据，但仍不是完整样本。`index complete=true` 且 `rows=[]` 仍表示结果投影未完成，不能解释为零承诺。

## 9. 恢复边界

候选 POST 最多一次，恢复 POST 最多一次。所有角色共享：

```text
action.lock
upload-attempt.json
restore-attempt.json
```

恢复前核对账号、活动分支和当前模块字节；仍是本轮候选才允许写旧生产原件，已是原件则不 POST，第三方代码不覆盖。POST 超时不重发，只允许只读回读判断结果。

字节恢复后创建独立 `closureId`，采集 75 秒 shard1 console 和账号级 CPU，并在运行确认前后回读旧生产字节。这段日志不能补诊断点，也不是原 collector 的连续段。

## 10. 上传后失败的固定收尾入口

只读对账，输出路径必须不存在：

```bash
node "$PKG/tools/reconcile.cjs" --compat "$COMPAT" \
  --run "$WORK/live/run" --secret "$SECRET" \
  --out "$WORK/reconcile-01.json"
```

仅在原进程已退出、部署仍排他、无遗留锁且恢复额度未消耗时，允许一次 operator 恢复：

```bash
node "$PKG/tools/recover.cjs" --compat "$COMPAT" \
  --run "$WORK/live/run" --secret "$SECRET" \
  --execute-recovery --exclusive-target --prior-workers-stopped
```

需要关闭本地 ON 配置时：

```bash
node "$PKG/tools/close-source.cjs" \
  --compat "$COMPAT" --run "$WORK/live/run"
```

不得删除锁、标记或 operator 目录后重试。

## 11. 独立验证与子阶段裁决

```bash
node "$PKG/tools/verify.cjs" --run "$WORK/live/run" \
  --out "$WORK/independent-verification.json"
node "$PKG/tools/compare.cjs" --run "$WORK/live/run" \
  --out "$WORK/subphase-attribution.json"
```

验证器从原始 console 帧重算，不信任 collector 摘要。裁决必须分别报告：

- raw／diagnostic／attributed／complete 数量；
- 九个子阶段的逐点值、中位数和 observation／commitment 排名；
- task／reservation／health／route／owner／bucket／projection counters；
- 父阶段值，但明确禁止与子阶段相加；
- commitment index 完整性、投影行数与完整样本判定；
- 最多 3 个后继尾部；末点尾部不可观测。

性能下降、上升或调用次数不足均须如实归档。不得自动授权某项优化，也不得计算跨轮因果提速百分比。

## 12. 归档、提交和推送

确认所有进程退出、本地配置 OFF 后：

```bash
node "$PKG/tools/archive.cjs" --refactor "$REFACTOR" \
  --run "$WORK/live/run" --tests "$WORK/tool-tests" \
  --offline "$WORK/baseline-checks" \
  --remediation "$WORK/remediation" --secret "$SECRET"

node "$PKG/tools/publish.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" --check-only
```

归档位置：

```text
openspec/changes/empire-treasury-core-rewrite/evidence/
legacy-read-bridge-i/compat-subphase-online-x
```

归档必须包含 remediation 原件、`SUBPHASE-ATTRIBUTION.json`、原始 run、离线门禁和完整任务包。私有 `backup.json`、`candidate.json`、`session.json`、凭据和构建产物不得入库。完整原生 `git diff --cached --check` 必须 exit 0，零例外。

创建唯一 evidence 提交并普通推送：

```bash
node "$PKG/tools/publish.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" \
  --out "$WORK/publish-receipt.json" --push
```

最终 compat 链必须是以下之一：

```text
fresh:
compat root
→ five-path remediation
→ temporary ON
→ exact OFF（tree 与 remediation source 完全相同）

continued:
compat root
→ exact legacy four-path partial
→ one-path provenance completion
→ temporary ON
→ exact OFF（tree 与 remediation source 完全相同）
```

两种模式的 remediation source tree 必须逐字节一致。

若只在 evidence 提交或推送阶段失败，保留索引和原件，使用新 out 路径续接；不得重跑在线实验、amend 或制造第二个 evidence 提交。

## 13. 回报与终态

回报：完整双分支 HEAD、remediation HEAD、包指纹、146/146、246/246、195/685、新窗口、四个 tick、每点父阶段和九子阶段、primitive counters、raw／diagnostic／attributed／complete、候选／恢复写边界、恢复前后摘要、75 秒运行证据、原生 whitespace 结果与限制。

满足实际证据时允许：

```text
SOURCE_MANIFEST_REMEDIATION_VERIFIED
CPU_DIAGNOSTIC_CAPTURE_VERIFIED
SUBPHASE_X_ATTRIBUTION_RECORDED
RESTORED_BYTES_AND_RUNTIME_VERIFIED
```

除非原始数据确实支持相反结论，继续保留：

```text
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
```

禁止直接报告：

```text
ONLINE_COMPAT_READ_OBSERVED
ENGINE_CPU_BUDGET_GAP_REPAIRED
TREASURY_PRODUCTION_READY
完整 Treasury 生产切换
```

若发生候选与恢复写入，必须如实写明，不能写成“未部署”或“无线上代码写入”。
