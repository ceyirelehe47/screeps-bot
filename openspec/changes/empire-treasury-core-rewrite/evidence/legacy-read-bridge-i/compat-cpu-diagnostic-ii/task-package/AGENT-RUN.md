# Compat CPU Diagnostic II · Agent 任务书
## 完整实现交付；四点受控 CPU 实测；唯一上传与受控恢复

### 0. 权限、职责及失败纪律

制作方已提供全部代码和测试。Agent 只核验、执行、保存原件并普通提交/推送，不修改实现、编写反例、放宽阈值或现场修包。

本轮允许：在锁定兼容源码上临时修改唯一配置文件，建立 ON 和 OFF 两个线性提交；在确认部署目标排他使用后，上传一次诊断候选；仍沿同一个 run 目录、同一个 restore-attempt.json 最多恢复一次。允许有界重试只读请求，不允许重发 POST。

本轮不允许：完整 refactor 部署、预算增加、市场/Terminal动作、console注入、Memory写、第二窗口、追加第5点、重启拼接观察、删除写入标记、amend/reset/force-push、清空旧实验或重建运行中的包目录。工具源码或包指纹变化立即停止新的动作，但不要杀死正在安全收尾的独立恢复进程。

上传前任一门禁失败：保留 stdout/stderr/exit，停止，不上传。进入 observe 后出现失败：停止的是诊断成功路径，不是恢复；必须等待已有恢复进程完成。代码源码恢复 OFF 不代表线上恢复。ONLINE_CLOSE_UNCONFIRMED 不能写成 RESTORED。

原生 Windows/Git Bash + Node22 是目标环境。不得以换 WSL、跳过测试、全局隔离 Git 配置或禁用签名/钩子修绿。包使用命令局部 LF 参数；不修改真实仓库 Git 配置。现有 user.name/email、签名或 hooks 若阻塞，应保留错误并报告，不更改以绕过。

### 1. 固定身份

- Repository: ceyirelehe47/screeps-bot
- Compat branch: compat/treasury-read-bridge-i
- Compat base: 43b1b8e51caca0c17b975971a71fbbb0951823bf
- Refactor branch: refactor/empire-treasury-rearchitecture
- Refactor base: bb1aa9900bfe6505ff6ef871ead0a0c61e7b1f1f
- Source package: 本包 INTEGRITY.json + references/source-lock.json
- Server/account: https://screeps.com / forster / 634fe406347a7b69b28aeccb
- Branch/shard: default / shard1
- Rooms/resources: E3N59, E4N58 / energy, H
- Old production commit: 06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c
- Old module-set digest: 84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf

两仓起始必须干净、本地与远端均匹配。CPU I 不再重应用。缺少固定对象/依赖或发现远端漂移时报告，不能自行换 base。

### 2. 路径与证据约定

解压到全新的 Git 工作树外目录。ZIP 顶层含本包目录名，不要套两层相同目录。保留旧包与失败现场。

以下是 Git Bash 的变量示例；只把路径改为本机实际位置。WORK 必须从未存在，PKG、WORK 与两个仓库不得互相包含或经 symlink/junction 指向仓库内部。

```bash
PKG="D:/code/screeps/incoming/screeps-compat-cpu-diagnostic-II-2026-09-12"
REFACTOR="D:/code/screeps/screeps-bot"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
WORK="D:/code/screeps/compat-cpu-diagnostic-II-execution"
SECRET="$COMPAT/.secret.json"
test ! -e "$WORK" || exit 1
mkdir "$WORK" || exit 1
```

SECRET 只传文件路径；不要打印、上传、复制凭据。main 段必须匹配本轮服务器与 default branch。完整 backup.json/candidate.json、dist 与 session.json 只留 WORK/live 下，不能 git add。

每条命令分别保存 stdout、stderr 和退出码到 WORK 的不同文件；不要覆写已有文件。run-tests、build、observe 自带内部原件；外层执行输出也须保留。目录名 tool-tests、baseline-checks、live、发布回执路径都由各自工具排他创建，不要提前 mkdir。

### 3. 包、基线与离线检查

```bash
node -e 'console.log(JSON.stringify(require(process.argv[1]).verifyPackage()))' "$PKG/tools/util.cjs"
node "$PKG/tools/check-baseline.cjs" --refactor "$REFACTOR" --compat "$COMPAT"
node "$PKG/tools/run-tests.cjs" --compat "$COMPAT" --out "$WORK/tool-tests"
node "$PKG/tools/build.cjs" --compat "$COMPAT" --out "$WORK/baseline-checks"
```

四条命令必须各自退出0。固定工具测试数量以 references/test-contract.json 为准，failed/skipped/todo/cancelled 均为0；摘要必须是 CPU_DIAGNOSTIC_TOOL_TESTS_VERIFIED。测试里有真实子进程、loopback假远端、真实读取器源代码与合成读端口，不属于线上CPU证据。

build 顺序：tsconfig.build.json、tsconfig.json 的 noEmit；原版 verify-jest-budget；Rollup build-only。要求195 suites / 685 tests，不能改预算。baseline-checks/result.json 必须绑定同一包指纹和 compat base。该预热构建不会上传；正式产物随后从新 ON commit 的干净 detached worktree 构建，不能沿用历史 dirty bundle。

### 4. 线上前提（未满足即不执行）

真实确认：没有其他 Agent、人、IDE watcher、CI 或自动部署会写 default 分支；旧观察/恢复进程已经退出；两仓仍干净；本包运行目录不会被删除、复制覆盖或更新；本机可以持续运行至截止后安全收尾。

`--exclusive-target` 和 `--prior-workers-stopped` 是真实确认，不是为过门禁填写的开关。无法确认则止于离线。服务端代码接口没有 CAS，本包不能消除外部并发部署竞争。

### 5. 一次性执行入口

```bash
node "$PKG/tools/observe.cjs"   --refactor "$REFACTOR" --compat "$COMPAT"   --offline "$WORK/baseline-checks" --tests "$WORK/tool-tests"   --work "$WORK/live" --secret "$SECRET"   --execute --exclusive-target --prior-workers-stopped
```

只运行一次。observe 在所有慢速离线检查完成后即时读取官方 tick，绑定：

`S = ceil((freshTick + 150) / 100) * 100`；采样为 `S, S+100, S+200, S+300`。

完整部署时序由同一入口完成：前检身份/字节 → ON commit（仅config）→ detached typecheck/build/源码身份与产物hash → 再读线上字节与 tick → 健康 collector 和独立恢复进程 → 上传前再要求至少100 tick提前量 → 排他持久 upload-attempt → 唯一候选POST与回读。

构建太慢、账号/分支/字节变化、上传提前量不足：不改窗口、不上传；关闭本轮本地 config 后报告。不要单独调用 prepare.cjs 绕过即时执行入口。

2 CPU、bucket 2000、reserve 5、maxLogBytes 16384、两房两资源全部不变。独立安全中止阈值为已报告前缀或尾部超过5 CPU；它是事后停止条件，不是提高读取器预算或硬实时中断保证。单个不可抢占阶段仍可能超出协作预算。

诊断预定最多4点；partial_cpu_budget 不自动结束观察，也不算完整样本。fault_disabled、output_limited、异常JSON、错误身份/顺序、重复冲突、通道断开/过期或明显超限仍触发恢复。没有自动重连，没有替换runId。

正常收到4点后立即收尾。缺点时由 tick窗口+20、停滞或45分钟墙钟截止收尾，以先到者为准。不要把工具stdout暂时无输出当成挂死而结束进程。

### 6. 安全恢复与运行证明

独立 recovery-worker 自行执行恢复，无需等待父进程下令；父进程仅在 worker 已退出时接管。所有 actor 共用原 run 的 action.lock、upload-attempt.json、restore-attempt.json，actor 分目录不增加写额度。

恢复读取：账号 → 活动分支 → default代码 → 活动分支；每次请求8秒、读取组最多3次、退避2秒/5秒。鉴权或身份错误不重试。没有 game/time 或 overview 依赖。先确认仍是本轮候选，锁内再次确认后才允许写旧生产原件；已是原件则不POST，第三方代码不覆盖。

恢复POST前必须排他写入并 fsync 同一个 restore-attempt.json。回复超时不重发；允许只读回读来判断是否已生效。标记写入失败也不删除标记后重试。父监督器、operator入口都遵守相同额度。

字节确认后新建恢复专用closureId，采集75秒 shard1 console + 账号级CPU，原始日志由独立 verifier 检查认证、时间跨度、最大45秒通道空隙、正CPU、唯一footer。新流不是原观察流的续段，也不能补诊断点。运行确认前后均须回读旧生产摘要。运行流失败不能遮蔽已经确认的字节。

持续网络故障或过期action.lock可能使恢复无法确认。180秒锁等待后不擅自清锁。未知候选写入结果尚未解决时，即使暂时读到旧字节也不宣称完全闭合。任何情况下都不能保证机器/网络断开后自动成功恢复。

### 7. 失败时允许的固定收尾命令

observe 的 exit 2 是诊断/恢复未完全通过，不代表必须重跑。先查看 WORK/live/run 的 driver-result.json、guard-result.json 以及 recovery-* 原件，并确认恢复进程已经终止。

仅需重新查当前字节时，可执行只读命令，out 必须是新文件：

```bash
node "$PKG/tools/reconcile.cjs" --compat "$COMPAT" --run "$WORK/live/run"   --secret "$SECRET" --out "$WORK/reconcile-01.json"
```

若仍未闭合，只有确认原进程都已退出、部署仍排他、没有遗留 action.lock 时，才允许一次 operator 收尾；现有 restore 标记会禁止第二次POST：

```bash
node "$PKG/tools/recover.cjs" --compat "$COMPAT" --run "$WORK/live/run"   --secret "$SECRET" --execute-recovery --exclusive-target --prior-workers-stopped
```

recovery-operator 目录排他创建，不能反复运行、删除目录重试。若存在存活进程/锁、第三方代码、已有POST但候选仍在线或读取持续失败：保留 ONLINE_CLOSE_UNCONFIRMED，报告制作方。不要盲目覆盖、删除锁、换运行目录执行恢复。

父进程异常退出后，等 guard 终止，再检查源码；需要时使用唯一已有关闭入口，不把源码关闭当成线上恢复：

```bash
node "$PKG/tools/close-source.cjs" --compat "$COMPAT" --run "$WORK/live/run"
```

### 8. 独立重算与分析

```bash
node "$PKG/tools/verify.cjs" --run "$WORK/live/run" --out "$WORK/independent-verification.json"
```

成功应为 CPU_DIAGNOSTIC_CAPTURE_VERIFIED + RESTORED_BYTES_AND_RUNTIME_VERIFIED。该结果不使用collector成功计数作证明，而重新解析原始console帧、CPU前缀/后继尾部、阶段和、调用计数、字节数、身份与通道连续性。

报告应区分 rawReports / diagnosticReports / completeSamples；4点完整诊断最多得到3个由后继报告携带的afterRetention尾部。末点尾部必须保持unobservable，不能补第5点。首次sampleOrdinal=1仅证明模块生命周期首次准入，不是引擎冷启动证明。阶段是含测量开销的区间，call=0不能解释为函数已经以零CPU完成。

即便4点都不完整，本轮仍可能成功定位阶段；不能据此写成兼容验收通过。若始终未进入commitment，其实际构建成本仍未知。不要由Node wall clock推导Screeps CPU，也不要把UTF-8遍历次数减半解释为整体CPU减半。

失败结果允许如实归档，但不得使用成功标签。恢复未确认时优先保留/报告安全状态，不要继续另一次实验。

### 9. 归档（工作树外快照不入库）

待所有进程退出、本地源码默认OFF后执行。归档器对白名单原件先做真实token及编码/前缀扫描，再装配；不复制backup、candidate、session或dist。不允许用git add整个WORK替代。

```bash
node "$PKG/tools/archive.cjs" --refactor "$REFACTOR" --run "$WORK/live/run"   --tests "$WORK/tool-tests" --offline "$WORK/baseline-checks" --secret "$SECRET"
node "$PKG/tools/publish.cjs" --refactor "$REFACTOR" --compat "$COMPAT" --check-only
```

位置：openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-cpu-diagnostic-ii。

stdout/stderr/TAP保留为含原字符串、原bytes和SHA-256的JSON，不修剪原件，也不让诊断本身的空格再次造成门禁冲突。补丁镜像使用Git生成，无旧的两行whitespace例外；本轮完整原生git diff --cached --check必须退出0。暂存字节须与装配清单完全一致。

### 10. 唯一证据提交与普通推送

```bash
node "$PKG/tools/publish.cjs" --refactor "$REFACTOR" --compat "$COMPAT"   --out "$WORK/publish-receipt.json" --push
```

Compat 若进入ON，则最终恰好两个config提交且OFF tree等于起始43b1b8e tree；未进入ON则可不前移。Refactor仅新增本轮evidence的一个提交。提交tree必须等于门禁通过时index tree。

若只在commit/push阶段失败，不重跑实验、不amend。原件与索引保持不动；确认失败点后，本工具可用新out路径复核已有唯一evidence提交并普通推送未到位分支，拒绝额外提交、远端第三方前移或force-push。

### 11. 回报内容

回报两个完整HEAD、普通push回读、包指纹、固定工具测试及195/685、绑定tick与4个实际tick、各阶段区间和首/后续差别、raw/diagnostic/complete三种计数、候选/恢复请求边界、恢复前后摘要与独立运行确认、原生whitespace=0，以及限制/偏差。

允许：CPU_DIAGNOSTIC_CAPTURE_VERIFIED / RESTORED_BYTES_AND_RUNTIME_VERIFIED。
有缺口：CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE；恢复字节已证但运行未证为RESTORED_BYTES_CONFIRMED_RUNTIME_UNCONFIRMED；其余保留ONLINE_CLOSE_UNCONFIRMED。

不允许：ONLINE_COMPAT_READ_OBSERVED、CPU_BUDGET_GAP_REPAIRED、TREASURY_PRODUCTION_READY、完整生产切换。若发生上传后恢复，不得写成“从未部署/无代码写入”；应明确一次候选写入、最多一次恢复写入。
