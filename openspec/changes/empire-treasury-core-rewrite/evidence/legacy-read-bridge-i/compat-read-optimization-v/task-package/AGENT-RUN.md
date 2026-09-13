# Agent任务书：Compat Read Optimization V

## 0. 任务与停止规则

本包是完整固定实现，Agent仅负责原生环境测验、真实仓库验证、提交与推送，不编写实现或增删测试。禁止调整阈值、预算、测试计数及源码冻结范围；不读取token，不连接Screeps，不运行任何旧observe/recover工具。预算2、默认OFF、窗口0不变。

任一门禁失败：保存本次stdout/stderr/exit和已有原件，立即停止；不删除工作目录，不重跑到变绿，不回退其他人的文件。自动应用只在自身写入失败时回滚自身修改。通过应用后若后续测试失败，保留12路径的未提交实现供审查。来源仓库若不干净或基线漂移，禁止猜测接续。

本轮不授权线上实验。CPU IV的4诊断/0完整、2次commitment构建与已恢复事实不改写；成功也不能标记ENGINE_CPU_BUDGET_GAP_RESOLVED或ONLINE_COMPAT_READ_OBSERVED。

## 1. 固定基线

```text
repository  ceyirelehe47/screeps-bot
compat      compat/treasury-read-bridge-i
base        af7cfb7507d42bb12a32b8ea9d85dadd87d97fae
refactor    refactor/empire-treasury-rearchitecture
base        838ae7b170e8eedd4bd7a9f53e7ceee24e560ce1
```

`references/source-lock.json`列出12条允许变更路径及每条旧blob/新SHA256；三份既有bridge/real-readers/independent spec、沙箱helper、Jest wrapper、CPU计量、运行装配和配置均冻结。唯一新作者文件是context变换器；其余生成器/模板、产物、溯源和loader回归入口按固定清单更新。不要直接手改生成文件。

## 2. 准备与路径（Git Bash / Windows Node）

使用原环境Node和仓库已安装TypeScript依赖，不要求WSL或大小写敏感文件系统。不屏蔽真实system/global Git配置。真实commit遵守原仓库身份/签名/钩子；工具只在临时测试或具体add命令局部固定换行策略。

下面三条路径对应现有仓库和新解压包；实际目录不同只替换路径变量。WORK必须是未存在的新目录，且在两仓库与PKG之外。不要删除已有WORK来重跑。

```bash
PKG='D:/code/screeps/incoming/screeps-compat-read-optimization-V-2026-09-13'
COMPAT='D:/code/screeps/screeps-bot-compat-read-i'
REFACTOR='D:/code/screeps/screeps-bot'
WORK='D:/code/screeps/compat-read-optimization-V-verification'
[ ! -e "$WORK" ] || { echo 'WORK_ALREADY_EXISTS'; exit 1; }
mkdir -p "$WORK" || exit 1
run() {
  name="$1"; shift
  "$@" >"$WORK/$name.stdout" 2>"$WORK/$name.stderr"
  code=$?
  printf '%s\n' "$code" >"$WORK/$name.exit"
  [ "$code" -eq 0 ] || { echo "STOP: $name exit=$code"; exit "$code"; }
}
```

先对下载ZIP核验外置`.sha256.txt`（PowerShell `Get-FileHash`或`sha256sum`），再执行内部完整性检查。不要把任何凭据放进PKG或WORK。

## 3. 固定执行步骤

```bash
run 01-package node "$PKG/tools/run.cjs" verify-package
run 02-baselines node "$PKG/tools/run.cjs" baseline --compat "$COMPAT" --refactor "$REFACTOR"
run 03-tests node "$PKG/tools/run.cjs" test --typescript-repo "$COMPAT" --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/tests"
run 04-apply node "$PKG/tools/run.cjs" apply --compat "$COMPAT" --snapshot "$WORK/before-apply"
run 05-source node "$PKG/tools/run.cjs" verify-source --compat "$COMPAT"
run 06-ab node "$PKG/tools/run.cjs" characterize --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/characterization"
run 07-project node "$PKG/tools/run.cjs" full-check --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/checks"
run 08-stage-source node "$PKG/tools/run.cjs" stage-source --compat "$COMPAT"
run 09-commit-source git -C "$COMPAT" commit -m 'perf(compat): share read definitions with private sample contexts'
run 10-source-commit node "$PKG/tools/run.cjs" verify-source-commit --compat "$COMPAT"
run 11-archive node "$PKG/tools/run.cjs" archive --compat "$COMPAT" --refactor "$REFACTOR" --tests "$WORK/tests" --checks "$WORK/checks" --characterization "$WORK/characterization"
run 12-archive-check node "$PKG/tools/run.cjs" verify-archive --refactor "$REFACTOR"
run 13-stage-evidence node "$PKG/tools/run.cjs" stage-archive --refactor "$REFACTOR"
run 14-commit-evidence git -C "$REFACTOR" commit -m 'evidence(compat): verify read optimization V offline'
run 15-commits node "$PKG/tools/run.cjs" verify-commits --compat "$COMPAT" --refactor "$REFACTOR"
run 16-publish node "$PKG/tools/run.cjs" publish --compat "$COMPAT" --refactor "$REFACTOR"
```

工具所有`--out`目标必须不存在，由工具创建。步骤03无需先应用源码，使用精确前后源码切片；此步123项reader＋21项工作流测试，失败/跳过/todo/cancelled均须0。步骤06是20个真实固定旧/新core＋旧/新preview的合成输入A/B，输出逐条字节等价、零Memory写入。两房两资源的独立访问计数由同一固定脚本生成，不接受人工填写。

步骤07实际执行：仓库4份Node spec共142项（不是全仓所有Node测试）、生成器`--check`、两套TypeScript检查、Jest 195 suites/685 tests、Rollup build-only。Jest wrapper仍是一项，不把内部Node用例再加到685上。不改195/685计数清单。构建入口清除部署环境；若设置DEST/NODE_OPTIONS等不安全变量会停。允许原任务类型的提交前dirty-worktree构建警告，但产物仅用于build检查，绝不可上传。

步骤08/13均执行原生`git diff --cached --check`，必须零诊断exit0，无任何patch豁免。应用使用固定payload；patch只是同字节的审阅/复现镜像，勿在步骤04后再次apply patch。暂存字节、已提交blob、提交父关系与路径集合均由工具复核。source和evidence各唯一一个线性提交。

## 4. 实现边界与验收重点

### 新上下文不是宿主revision替代品

旧只读capsule每次初始化一个revision=0的私有模块，公开API不能bump/reset它。V将这个零值与本次`new Set(RESOURCES_ALL)`放进新builder闭包，显式传给commitment builder和两个验证函数。没有共享可变activeContext；并存/交错/嵌套builder不相互覆盖资源目录。原宿主Treasury服务完全不改，不能把本优化迁入宿主服务而沿用revision=0。

### 聚合校验仍是原实现

原8个canonical源身份冻结。只有generated commitments factory经过7类、12处可逆替换，并移除1条revision导入边；逆变换后整个原factory/依赖前缀必须精确还原。原revision factory正文作为不可达原定义保留，实际不初始化。所有task/reservation全表扫描、损坏/溢出/incomplete、owner排除、expiry、完整索引查询与动态receiver投影保持原算法。没有简化为只算H/energy的第二套承诺模型。

首次成功初始化7个定义，之后0个；每样本仍复制资源目录Set/新context/新builder。每次build仍创建全新observation/index/metrics。不是零加载CPU，也不是跨样本业务缓存。首次初始化/目录复制仍在样本准入后的readerLoad预算里。

### Store只在一次endpoint同步读取内复用引用

预算门禁、CPU profile、调用次序、容量检查和所选资源方法调用都不改。直接读取的Store属性访问24→4；core仍独立读取，访问数12，原方法调用序列保持一致。只是局部引用，不保存活Store，也不用direct值或旧投影构造core observation。

边界：原生Store在单次同步endpoint读取内应是稳定的同一个对象；刻意每次返回不同对象的自定义getter不属于字节等价域。缺失/抛错、容量变化、跨样本对象替换、稀疏/方法对拍不一致均仍覆盖。

## 5. 原件与提交/推送续接

白名单归档目标：
`openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-read-optimization-v`

归档原包、测试原始stdout/stderr/TAP的无损JSON包装、全仓检查原件、A/B结果和最终报告。不入库node_modules、dist、私有模块、token、旧run日志或其他任务目录。原来CPU IV与Loader III的任何证据都不能修改。

失败在commit或push阶段时保留现有状态，不自动重跑测试/应用/归档。经确认是发布阶段问题，允许直接核验并续接已创建的提交：

* source已提交、evidence未装配：先`verify-source-commit`，然后使用原03/06/07结果从11继续；禁止再做baseline/apply。
* evidence已经装配/暂存：先相应`verify-archive`（`--staged yes`验证暂存字节），保留原目录；没有commit时只补执行原14。
* 两提交已存在：执行15后续接16。publish接受远端仍在base或已经到本轮正确head，永不force/amend，不生成第二次实验。

这只是核验已通过步骤的发布续接，不授权修源码、改测试或重做线上实验。未知差异必须停止汇报。

## 6. 最终报告

完整验证与双分支推送回读通过后报告：

```text
READ_V_OFFLINE_VERIFIED_NOT_DEPLOYED
PRIVATE_SAMPLE_CONTEXT_WITH_SHARED_DEFINITIONS
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
NOT_DEPLOYED
```

列出两个完整SHA、测试分层结果、20场景A/B、30→7 factory计数、24→4 Store属性计数、原生whitespace结果、push回读、WORK位置及任何偏差。

不能宣称引擎CPU已下降某百分比，不能宣称预算已修复或完整国库生产就绪。下一轮实测必须重新制作新窗口包，不能直接复用CPU IV旧包的固定源码身份和tick。
