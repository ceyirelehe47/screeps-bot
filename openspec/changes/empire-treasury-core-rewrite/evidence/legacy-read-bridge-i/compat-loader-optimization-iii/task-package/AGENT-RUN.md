# Compat Loader Optimization III · 完整实现验证任务书

## 0. 范围和停止纪律

本轮不是新线上观察。禁止读取或使用token、连接Screeps、上传任何候选、执行恢复、开启配置或提高预算。不得重跑CPU Diagnostic II、重写既有证据、修改固定实现或测试来修绿。Agent不设计schema，不实现功能，不修改阈值。

只有本包明确列出的11条compat路径允许变化。refactor只增加本轮evidence目录。生产核心8个factory正文、依赖边、直接读取算法、CPU检查点、runtime装配、config及三份原Node spec保持冻结；两个源码文件仅注释变化。首次加载仍计入采样预算。

任一步失败：保存完整输出，在失败状态停止，不自动恢复/重置用户工作树，不删除WORK，不撤销已提交内容，不force push。此处停止不涉及任何线上安全收尾，因为本轮没有线上运行。测试源代码不可修改；不得跳过全量检查或把模型计数换算成引擎CPU。

本包只接受干净起点。CPU Diagnostic II已经验收并提交；不要把它的ON窗口重新打开。

## 1. 固定身份

仓库：ceyirelehe47/screeps-bot

compat/treasury-read-bridge-i:
745231048d97fd43fa7613abe988ae324bea10f8

refactor/empire-treasury-rearchitecture:
2d97f0d93a1bf02191bf4712f1201638263e09ea

原生成核心blob：c44d8a306f2b11986c6556e098be7d2e10315fa6
原模块来源commit：01bd9831454950c4928df98dd8679692b55603e5

核对交付消息中的ZIP SHA-256和旁侧sha256文件，再解压。不要重新压缩后比较旧ZIP摘要。INTEGRITY.json核验精确文件集合与逐文件字节。

本机使用Node 22和仓库已锁定依赖。无需WSL、大小写敏感目录或屏蔽Git system/global配置。不得修改用户Git身份、签名、钩子设置。临时Git测试与暂存写入自身固定换行策略，工作树检查则尊重实际Git配置。

下列命令为PowerShell写法，Git Bash可使用等效变量。路径由实际worktree确定，不得用本任务书猜测其他目录：

```powershell
$PKG = "<本包解压后的绝对路径>"
$COMPAT = "<compat工作树绝对路径>"
$REFACTOR = "<refactor工作树绝对路径>"
$WORK = "D:/code/screeps/compat-loader-optimization-III-verification"
if (Test-Path $WORK) { throw "WORK already exists; preserve it and choose a new empty directory" }
New-Item -ItemType Directory -Path $WORK | Out-Null
```

WORK和PKG必须在两个Git工作树外；勿清理前几轮目录。每个执行命令都检查退出码，不因管道/重定向吞掉失败。工具的test/full-check阶段自行保存stdout/stderr/exit为无损JSON包装。其他命令也应在WORK外部结果文件中保存stdout/stderr和实际exit，不覆盖已有文件。

## 2. 包和仓库前检

```powershell
node "$PKG/tools/run.cjs" verify-package
node "$PKG/tools/run.cjs" baseline --compat "$COMPAT" --refactor "$REFACTOR"
```

第二条实际查询两条origin远端HEAD并比较；不能把陈旧tracking ref当作新鲜确认。要求两树干净、HEAD/branch与固定值一致，变更前blob及保护文件匹配。

## 3. 固定测试，尚不改工作树

```powershell
node "$PKG/tools/run.cjs" test --typescript-repo "$COMPAT" --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/tests"
```

必须完整通过：
- 97项reader测试：51项原有bridge/real-readers + 46项新增loader测试。
- 18项工作流测试：包括原生whitespace、应用回滚、真实临时Git归档→暂存→提交→本地bare remote推送回读。
- failed/skipped/todo/cancelled均0。

这一阶段在WORK/tests/repository-slice中物化真实源码，Room/Memory为合成输入。不得将其称为整仓195/685已完成。临时Git工作流中的历史执行记录也是标明用途的合成夹具。

## 4. 应用唯一补丁对应的完整字节

```powershell
node "$PKG/tools/run.cjs" apply --compat "$COMPAT" --snapshot "$WORK/input-snapshot"
node "$PKG/tools/run.cjs" verify-source --compat "$COMPAT"
```

apply使用implementation中的完整文件，效果须与patches/SERIES一致，不需要再git apply一次。写前快照留在Git外；写入失败会回滚本次修改并保持原CRLF字节。若回滚也失败，报告明确状态与快照路径，不继续执行。

允许11路径：

```text
docs/treasury-compat-loader-optimization.json
docs/treasury-compat-source-manifest.json
scripts/build-treasury-compat-loader.cjs
scripts/lib/treasury-compat-loader.template.txt
src/runtime/treasuryCompatRead.ts
src/runtime/treasuryCompatReadCore.generated.ts
src/runtime/treasuryCompatTypes.ts
test/treasury-compat/fixtures/core-before-loader-optimization.ts.txt
test/treasury-compat/loader-optimization.spec.cjs
test/treasury-compat/loader-test-support.cjs
test/treasuryCompatRead.test.ts
```

其余路径不动。config仍enabled=false、窗口0、预算2。新增baseline fixture是原核心的完整固定字节，用于离线A/B，不导入生产runtime。Jest wrapper只增加新Node spec路径，不增加Jest测试项，不调测试预算。

## 5. 真实核心A/B

```powershell
node "$PKG/tools/run.cjs" characterize --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/characterization"
```

20场景全部通过：任务0/1/16/256/257、损坏/缺失、预留活动/精确到期/过期、owner、容量、缺端点、稀疏对拍差异和旧投影不一致。

每个场景旧/新各12次。业务报告与阶段诊断在相同模型CPU条件下逐条字节相等；Memory写次数0；原factory总数96，新30。返回的readerLoad调用仍12，不能以内部factory减少冒充少读样本。

输出中明确actualEngineMeasurement=false。首点factory仍8；首次发布共享定义的附加成本未做引擎测量。directRead未改，首点高成本未解决。不得从factory次数推导CPU减少百分比。

## 6. 真实仓库全量检查

```powershell
node "$PKG/tools/run.cjs" full-check --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/project-checks"
```

本步骤完整执行：全部四份仓库Node specs（原70 + 新46 = 116）、确定性生成--check、tsconfig.build.json和tsconfig.json两套类型检查、Jest195 suites/685 tests、Rollup build-only。每项exit0且最终源码保护检查通过。

不得设置DEST、DEPLOY_ALLOW_DIRTY、NODE_OPTIONS或NODE_PATH来改变构建/加载。真实仓库依赖直接由node_modules解析；不升级依赖。执行前发现这些构建注入变量时应停止报告，由用户环境确认后清理变量，不修改系统Git配置。

build-only在未提交源码上可能报告dirty身份；这是离线编译证据，不是可直接上传的候选包。本轮所有dist产物留在原ignore范围，不归档、不上传。

## 7. 唯一compat源码提交

```powershell
node "$PKG/tools/run.cjs" stage-source --compat "$COMPAT"
node "$PKG/tools/run.cjs" verify-source --compat "$COMPAT" --staged yes
git -C "$COMPAT" commit -m "perf(compat): reuse audited loader definitions with fresh sample state"
node "$PKG/tools/run.cjs" verify-source-commit --compat "$COMPAT"
```

暂存字节必须等于payload，scope正好11文件，原生whitespace检查exit0。commit沿用用户正常身份和签名设置，唯一父提交是7452310…；不要amend。

若提交命令失败且stage仍在，只重新verify-source --staged yes后续接提交；不要重跑apply/stage-source。若提交成功但后续失败，保留源码提交，可用verify-source-commit复核，不造第二个compat提交。

## 8. 白名单归档和唯一evidence提交

```powershell
node "$PKG/tools/run.cjs" archive --compat "$COMPAT" --refactor "$REFACTOR" --tests "$WORK/tests" --checks "$WORK/project-checks" --characterization "$WORK/characterization"
node "$PKG/tools/run.cjs" verify-archive --refactor "$REFACTOR"
node "$PKG/tools/run.cjs" stage-archive --refactor "$REFACTOR"
node "$PKG/tools/run.cjs" verify-archive --refactor "$REFACTOR" --staged yes
git -C "$REFACTOR" diff --cached --check
git -C "$REFACTOR" commit -m "evidence(compat): verify loader optimization III offline"
node "$PKG/tools/run.cjs" verify-commits --compat "$COMPAT" --refactor "$REFACTOR"
```

目标仅为：
openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-loader-optimization-iii/

归档包括原包、固定测试原件、20场景结果和完整项目检查JSON。不复制物化的repository-slice、node_modules、快照、dist、凭据或旧线上日志。stdout/stderr包装保留原text、bytes、SHA-256，不能trim再算摘要。

原生git diff --cached --check必须exit0，零例外；不使用v3的旧patch例外。补丁由git生成且抑制空上下文前缀空格。归档的.gitattributes只在本目录内固定原字节，不改仓库全局属性。

如果归档已装配，只verify，不重装配或删除它；已暂存只verify-archive --staged yes；evidence commit已成功则只verify-commits。只要固定输入和结果完全一致，提交/推送阶段可续接，不需要再次执行测试、A/B或构建。不同或未知状态必须报告，不猜测恢复。

## 9. 普通推送及回读

```powershell
node "$PKG/tools/run.cjs" publish --compat "$COMPAT" --refactor "$REFACTOR"
```

发布前复核两条唯一提交及整个evidence提交内容。远端只允许处于起始base或本轮精确终点；发现第三方前移即停止。没有force push、reset或amend。

某条push成功而另一条失败时，修复网络/认证环境后可原样重新运行publish；已到精确终点的一条只回读，不新增提交。不要因推送问题重跑前面工作。

## 10. 最终报告

必须给出两条完整SHA、push回读、原生Windows/Node/TS版本、97/18/116与195/685各自结果、20场景摘要、唯一变更范围、当前OFF与预算2。

全部通过才报告：

```text
LOADER_III_OFFLINE_VERIFIED_NOT_DEPLOYED
DEFINITION_REUSE_WITH_FRESH_SAMPLE_STATE
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
NOT_DEPLOYED
```

不得报告CPU_BUDGET_GAP_REPAIRED、ONLINE_COMPAT_READ_OBSERVED或TREASURY_PRODUCTION_READY。原CPU Diagnostic II的4条有效诊断、0完整及已闭合恢复不变；本轮无新引擎成本数据。
