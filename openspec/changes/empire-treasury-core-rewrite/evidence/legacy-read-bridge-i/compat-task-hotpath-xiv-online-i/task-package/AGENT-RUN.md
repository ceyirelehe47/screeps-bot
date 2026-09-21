# Agent 任务书：Task Hotpath XIV + Online I

## 0. 目标与固定边界

本包已实现源码、固定补丁和执行工具。Agent 负责在真实 Windows/Node.js 22 环境独立核验、执行、收集原始证据及普通 fast-forward 推送，不现场修改包、源码或测试来“修绿”。

本轮做两项保语义优化（样本级投影路径游标、task 安全整数累加内联），并用最多一组 first-valid-pending 固定探针继续定位 task 区间的大额成本。不是预算缺口修复声明，不是 12 点观察，不运行 Treasury facade/lifecycle/行动链。无在线预热，不跳过记录，不跨 tick 缓存业务结果。

固定仓库：ceyirelehe47/screeps-bot。

- compat/treasury-read-bridge-i 起点：85177467e71dcdbf9873bf6c2cd6cddb207a1c15；tree a9af213f779a79aaf852e0b8a4463f135123ccc8。
- refactor/empire-treasury-rearchitecture 起点：1666c5530856239207d32690f2f284cc8633d3d6。
- 上轮 XIII run/recovery/result.json 的固定 Git blob：64483883aeefd4164460571109d555ec5edb0af6。工具检查通过才允许本轮。
- 修正后默认 OFF tree 由 source-manifest.json 固定：0391f4b73522f02829f5151b455a5e5b45d0ab9c。
- source commit 消息：perf(compat): streamline task arithmetic and sample path reads。

这次新授权只能用于此包 policy.json 中的一个 authorizationId/runId。旧 XII recovery 的两次尝试额度已消耗，不重新开启。新实验本身最多 candidate POST 1 次、restore POST 1 次，两者都不自动重发。错误、超时、丢回包之后只读对账；读取第三种字节或账号/activeWorld 不符则拒绝写入。

线上目标仍为 forster / default / shard1；E3N59、E4N58；energy、H；4 点；间隔 100 tick；2 CPU 准入预算；reserve 5；minBucket 2000；maxLogBytes 16384；观察到 >5 CPU 为诊断安全停止。不要提高这些值。

## 1. 环境与目录

必须从全新的目录执行；不要复制、删除、重命名旧账本以刷新配额。原来的备份和失败证据原样保留。没有 materialize 步骤。

以下命令使用 Git Bash；根据实际解压的目录层级设置 PKG，必须指向包含 policy.json、tools、AGENT-RUN.md 的目录。凭据路径沿用已验证的本地配置，不在日志打印 token。

```bash
PKG="D:/code/screeps/incoming/screeps-compat-task-hotpath-XIV-online-I-2026-09-21"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
REFACTOR="D:/code/screeps/screeps-bot"
WORK="D:/code/screeps/compat-task-hotpath-XIV-online-I-execution"
SECRET="$COMPAT/.secret.json"

test ! -e "$WORK" || exit 1
mkdir "$WORK"
unset NODE_OPTIONS NODE_PATH DEST DEPLOY_ALLOW_DIRTY NODE_TLS_REJECT_UNAUTHORIZED
node --version
node "$PKG/tools/verify-package.cjs"
```

凭据文件需要 main.hostname=screeps.com、main.branch=default，以及合法 token；若本机此前使用另一已验证路径，只调整 SECRET 变量，不能修改包。不把凭据复制入包/归档。不设置 DEST、DEPLOY_ALLOW_DIRTY、NODE_OPTIONS、NODE_PATH 或禁用 TLS 校验。

核对两个本地分支、工作树和远端仍处于固定起点；不得 reset/amend/rebase/merge/force-push。旧 worker、collector 和其他部署进程必须已经退出。实验期间独占目标账号代码写入权；这是 --exclusive-target 和 --prior-workers-stopped 的事实前提，不是无条件填 true。

## 2. 包工具门禁与源码应用

```bash
node "$PKG/tools/run-tests.cjs" --out "$WORK/tool-tests"
node "$PKG/tools/apply.cjs" --compat "$COMPAT" --refactor "$REFACTOR" \
  --out "$WORK/source-application.json"
```

要求包测试 65/65、零 failed/skipped/todo/cancelled；完整性逐文件匹配。包工具只使用 Node 标准库，包含真实大小 loopback HTTP、丢失回包、独立观察器、原生 Git 应用/ON/OFF/归档/本地远端推送及验证器负例。

apply 先验证两分支、上次已闭合恢复、远端起点，再用固定 patch 应用 17 路径并创建唯一 source commit；完整 tree 必须等于上述 expected tree。已存在精确同一 source child 时只读 resumed，不创建第二个提交。任何其他本地状态停止，不提供旧 source 替换或历史改写授权。

生成文件只能由固定生成器产生；不得手改 Core、manifest 或 provenance。本轮 Core generated 和 Preview 均有变化，固定 patch 包含生成器的真实输出；--write/--check 必须能逐字节复现，并可逆还原为经 SHA 认证的 XIII 字节。历史 IX/XI/XII/XIII 变换不能被混当成当前变换。

## 3. 完整真实仓库离线门禁

```bash
node "$PKG/tools/build.cjs" --compat "$COMPAT" --out "$WORK/offline-checks"
```

必须完成：

- 仓库 node_modules 中的 TypeScript 精确 5.9.3；使用本机已有的锁定依赖，不能升级 package-lock。
- 10 个 Node spec，378/378，零 failed/skipped/todo/cancelled。
- generator --check、--write 后工作树仍干净、再次 --check；13 项 manifest output identity 全覆盖。
- tsconfig.build.json 与 tsconfig.json，均 tsc --noEmit exit0。
- tools/profile-local.cjs 自动执行四种 synthetic 输入形状，每版本 8 次真实本地 builder 调用，要求所有 indexed API 结果一致且 Memory 零写入；输出 local-replay.json。
- 原仓库 verify-jest-budget.mjs，195 suites / 685 tests，通过未变更的预算门禁。
- 干净 detached worktree 中 Rollup build-only；构建 commit/tree/default 目标与嵌入 bundle hash 一致。

只有 TASK_XIV_OFFLINE_VERIFIED 才能继续。源树有任何新增噪声、scope/hash 不符或确定性错误，都保留 stdout/stderr/exit 证据并停止，不能删门禁、修改计数或授权网络写入。

## 4. 唯一一次在线入口

确认上述事实与所有进程状态后执行一次：

```bash
node "$PKG/tools/observe.cjs" --compat "$COMPAT" --refactor "$REFACTOR" \
  --work "$WORK/live" --offline "$WORK/offline-checks" --tests "$WORK/tool-tests" \
  --secret "$SECRET" --execute --exclusive-target --prior-workers-stopped \
  > "$WORK/observe.stdout" 2> "$WORK/observe.stderr"
OBSERVE_EXIT=$?
printf '%s\n' "$OBSERVE_EXIT" > "$WORK/observe.exit"
```

observe 内部执行完整闭环，不手工调用旧包的 observe/recover：

1. 在 compat 的 Git common-dir 下先持久化此 authorization 的唯一启动凭据。换 WORK 不会生成第二次额度。
2. 最长 30 分钟只读就绪等待；3 次成功读取精确 canonical 旧生产、账号、唯一 activeWorld、房间归属、单调 shard tick。网络瞬态可以在这一读取阶段有界重试；稳定非 canonical 字节立即停止。
3. 离线门禁都结束后才取新鲜 tick，并建立唯一 ON commit；4 点绝对窗口从当前 tick +150 向上对齐 100。禁止补第5点或自动重绑新窗口。
4. detached candidate build、再次精确核对旧生产并保留 private backup/candidate；窗口至少仍有100 tick lead，否则停止并关闭源码配置。
5. 启动新 collector 与独立 recovery worker，确认认证和 console/CPU 通道就绪；marker 先落盘，再发送最多一次候选 POST，并读回验证。
6. 正常收到4条报告、安全闩触发、健康检查失败、父进程退出、超时等都会进入恢复。独立 worker 不依赖父进程继续存活。
7. 恢复前只接受精确本候选或精确备份；新 restore marker 先落盘，最多1次恢复 POST。HTTP 读/写上限固定，不进行自动写入重试。
8. 稳定读到旧生产之后，开启新的 75 秒 WebSocket 运行确认，并在结束后再次独立确认旧生产字节。
9. Git 配置恢复 OFF，tree 必须再次精确等于 source tree。这个 Git 结果不替代线上恢复证据。

此工具打印验证结果；capture 未通过时 exit2。退出码非0不构成重跑 observe 的授权。若父进程异常，先检查独立 worker 是否仍在执行恢复，不启动其他写入方。不要把“采集结束”当成“线上已经恢复”。

## 5. 固定优化、局部回放和有界归因

投影根路径在每个 admitted sample 内懒解析一次；own-data 检查使用一次 descriptor 读取，不调用 accessor，也不使用旧投影替代任何 Store 读取。原样本已经捕获的 runtime 根仅为这一个样本的路径游标；下一个样本重新读取。

普通 pending task 的四次 checked-add 辅助函数调用替换为相同加法和 Number.isSafeInteger 检查。完整扫描、溢出标记与后续扫描、损坏输入、pending/healthy 区分、所有资源、self-route alias、owner/expiry、route first-wins、reservation 和完整索引查询语义不删减。

原 XIII 五段外层计时及九个子阶段保留。新增 taskBoundaryDiagnostics 仅在这些诊断都开启时启用。只为表中第一个合法 pending task 记录一个 start/end 对，ordinal 包括前面无效和非 pending 记录。开始点在该记录验证之后、pending 处理之前；finally 保留 overflow/continue/fault 的终点。它将原 commitmentTasks 区间分成：

- beforeFirstValidPending：表准备、前面记录和首条合法 pending 的验证；
- firstPendingProcessing：选中记录的 pending 处理区间；
- remainingTable：其余全部记录和表结束余项。

空表或没有合法 pending 的表新增 0 次 CPU 读取；1/6/256 条 pending 均只新增 2 次。没有每条记录打点，不为了测量重复调用 builder，不在上线前隐藏预热一次。探针本身成本保留，不减去估计开销。

这些区域与原 commitmentTasks、measuredBody 和父阶段重叠，不能重复求和。not_called 不是 0 CPU 构建，no_pending 不是“无效记录可以视为空”；所有完整性结果仍由实际 builder 决定。验证器检查顺序、有限值、父区间求和、body 包含关系、ordinal/work 一致以及 tail 不重复携带历史。

本地回放不是线上故障复现。原 XIII 的六条具体 task 没有采集，四种本地 workload 只是公开 fixture 的合成数据。Node wall-clock、VM 包装、Proxy 保护和不同编译版本不能换算成 Screeps CPU，也不能用于宣布 JIT/GC 或 14 CPU 尖峰根因。local-replay.json 会分别保留 first actual local call 和后续调用，不合并冒充冷启动/热启动引擎结论。

XIII 的 heap-local >5 CPU 安全闩和晚启动拒绝保持。新 pair 的 CPU 读取也供同一安全闩观察，但不跳过当前完整 task 扫描。闩阻止同一实例的后续样本，不能抢占正在执行的同步调用，不能保证当前调用不超过5，也不代替恢复。它不写 Memory；不得宣称跨 reset 持久 exactly-once。控制消息不是第五个业务样本。

raw、安全拒绝 raw、accepted diagnostic、complete business sample 和 tail profile 分开统计。前三点无调用时 preCommitmentCpu 仍有价值，不把 null task 成本写成0。超过安全阈值的闭合 trace 只作 forensic 分组，不补成四点通过。原 XIII 的 4 raw / 3 accepted partial / 0 complete 结论不改写。

## 6. 验证、只读对账和归档

observe 结束且 worker 已退出后：

```bash
node "$PKG/tools/verify.cjs" --compat "$COMPAT" --run "$WORK/live/run" \
  --out "$WORK/FINAL-VERIFICATION.json"
```

若 session.json 存在但恢复不确定，只允许：

```bash
node "$PKG/tools/reconcile.cjs" --run "$WORK/live/run" --secret "$SECRET" \
  --out "$WORK/RECONCILIATION.json" \
  > "$WORK/reconcile.stdout" 2> "$WORK/reconcile.stderr"
```

这是只读 identity 对账，不发 POST。候选写入结果不明且没有已记录恢复尝试时，即使读到备份字节，仍保留 uploadOutcomeResolved=false，不把可能仍在途的候选写入声称为完整恢复闭环。没有 session、未发生候选写入时不运行 reconcile，按 NOT_DEPLOYED 保留 preparation failure。严禁删 candidate-attempt / restore-attempt / Git common-dir 授权记录或复用旧事故恢复包。

若线上不是精确旧生产，停止新性能工作；保留全部证据并报告需要新的独立恢复决策。没有新授权时不自动增加恢复额度。

当相关进程终止、Git 默认 OFF、工作树干净时，归档并发布无论成功或 INCONCLUSIVE 的证据：

```bash
node "$PKG/tools/archive.cjs" --compat "$COMPAT" --refactor "$REFACTOR" \
  --work "$WORK" --secret "$SECRET" --push \
  > "$WORK/archive.stdout" 2> "$WORK/archive.stderr"
```

归档路径由 policy 固定。refactor 只新增一个 evidence commit；compat 普通 fast-forward 推送 source→ON→OFF 链（若未绑定窗口则只有 source）。不改 refactor 的 src/scripts/test/依赖或构建配置。

归档包含源码包、离线日志、运行原始证据、独立 FINAL-VERIFICATION、自动重算的 TASK-ANALYSIS 和完整 hash 清单；排除 private backup/candidate、detached build 和凭据；native git diff --cached --check 零例外。归档提交完成后若 Git 网络瞬态失败，可在确认远端只处于本轮允许的起点/终点后重跑同一 archive --push；它只核验既有归档并继续幂等普通推送，不重建源码/窗口/网络写入。若归档提交前发生确定性失败或留下脏工作树，则保存证据并停止，不手工修绿。

## 7. 允许的终态与交付报告

成功诊断和恢复是两个独立轴：

- CPU_DIAGNOSTIC_CAPTURE_VERIFIED：恰好4条有效报告、链身份与原始日志完整、恢复及OFF闭合。业务 complete 数可小于4；不能因此宣称2 CPU稳定。
- CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE：安全停止、样本不全、运行/字节证据不全，诚实保留 raw 与失败原因。
- RESTORED_BYTES_AND_RUNTIME_VERIFIED：独立字节与75秒运行证据闭合。
- RESTORED_BYTES_RUNTIME_UNCONFIRMED / ONLINE_CLOSE_UNCONFIRMED：不得写成已恢复全闭环。
- NOT_DEPLOYED：没有候选写入，不需要新增恢复 POST。
- TASK_XIV_EVIDENCE_PUSHED：只代表证据已推送，不代表采集/预算/生产通过。

报告需要给出完整两分支 HEAD、source/ON/OFF tree、源码范围、包/离线门禁结果、raw/accepted/complete/拒绝原因、每次实际调用的五段计时、first-pending 三段及 ordinal/work、调用前常规开销、local-replay 限制、子阶段重叠说明、候选/恢复尝试数、恢复身份与75秒结果、最终停止点。不把调用入口间隔直接命名为JIT/GC/算法扫描；不可观测或不能解释的部分保持未知。

继续保留 ENGINE_CPU_BUDGET_GAP_UNRESOLVED。禁止宣布 12 点通过、FULL_COMPATIBILITY_OBSERVED、Treasury 生产就绪。原 execution 目录和真实 backup/candidate 留在本地供后续审查，不删除、不入公开 evidence。

## 8. 制作端验证边界

制作端从用户提供的完整源码工作树重建内容，核验 XIII 基线完整 tree，恢复并 SHA 验证真实基线 commit 对象，已用本包生产工具在该真实基线上执行 apply/resumed/ON/OFF，source tree 精确一致。另已运行 378 项仓库 Node 测试和65项工具测试、局部类型检查、固定生成器和合成 API 等价回放。

制作端可用编译器为5.8.3；局部类型检查使用与仓库相同的非 strict 选项和宽松 Screeps 环境声明，不代替真实项目。没有冒充完成5.9.3双 tsc、Jest195/685、Rollup、Windows实机或真实 Screeps在线阶段。§3必须由Agent完整重跑，不因为制作端测试通过而跳过。

已认证源树不等于完整历史 clone；真实旧生产 main、父目录tree和commit对象用于原生Git对照，其他不需要的历史对象不作已获取声明。maker-evidence 是制作端实际记录，不是当前线上状态。生产恢复字节只以本次run的真实备份和读回为准。
