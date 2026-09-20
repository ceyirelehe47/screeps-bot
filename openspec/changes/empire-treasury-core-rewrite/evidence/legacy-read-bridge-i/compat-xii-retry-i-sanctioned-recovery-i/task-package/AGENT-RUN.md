# Agent 任务书：XII 独立受控恢复 I

## 0. 本轮唯一目标与授权

立即优先闭合未确认的生产恢复。禁止新优化、新观测、第五个点、提高 CPU 预算、重建 production main、把候选认定为正式生产。

本包适用于唯一原 run：`29f70e2b78cb26a9bec4697ffeab165f`。历史 experiment restore 已尝试 1 次；新任务书在账号所有者转交执行后新增最多 1 次受控恢复授权。明确使用 `--authorize-additional-restore` 才会打开此新增写入边界。旧 marker、旧账本、旧证据必须原封保留。不得重新执行旧 observe/recover，不得删除任何 attempt 文件，不得换目录复制 run 以刷新配额。

不得通过网页粘贴源码或注入 Screeps console 来替代本包写入。恢复只提交原 run/backup.json 中经完整哈希校验的 modules，不把本地 OFF 构建当成历史生产备份。

本包未替用户做过真实网络恢复。包交付与恢复完成是两件事。

## 1. 固定身份

| 用途 | 固定值 |
|---|---|
| 目标 | https://screeps.com / forster / default / shard1 |
| compat 当前 HEAD | 8c1ddecc126f4aee116d46b88547eafdd0e47d37 |
| compat 默认 OFF tree | dcec716dfad41cb95e07bbed5988f1d5fde5c531 |
| refactor evidence 基线 | ed7eb284c38e3bd346c4b8013aec2ee5124f2b4d |
| 已知候选构建 | 2b6f332c172c49eb335962a967b337ddcdbe63e3 |
| 旧生产构建 | 06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c |
| 旧生产 main | 4494463 bytes / 37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b |
| 候选 main | 4606347 bytes / 5292b7f7db75756708b7f27d67a05f624ae751238ae47356925c65641d6af0ef |
| backup.json 文件 SHA-256 | ffd003d8620352b842869c1a0be38ff14a530be2c3e5741f112be94ff45c0109 |
| candidate.json 文件 SHA-256 | 3c966ccd92c1b5a87752914ead11a8a747f8b40ca4b6cb510f19ad0762269b83 |

policy.json 同时固定 16 份原执行产物的长度和 SHA-256；canonical deployGuard 的 Git blob 也固定。恢复不依赖 GitHub 网络可用性，不受 290 项源码测试或新构建耗时阻塞。发布阶段再检查两个本地与远端分支。

## 2. 目录与前置事实

使用 Node.js 22，沿用此前有效的凭据绝对路径。不要把凭据复制到包、原 run、WORK 或仓库内。不要输出 token、环境变量内容或完整 HTTP 身体。

Git Bash 示例；PKG 指向本 ZIP 解压后的根目录。SECRET 沿用原有效凭据，不能把尖括号占位符原样执行。

```bash
PKG="D:/code/screeps/incoming/screeps-xii-sanctioned-recovery-I-2026-09-20"
RUN="D:/code/screeps/compat-diagnostic-envelope-XII-online-II-retry-I-v2-execution/live/run"
WORK="D:/code/screeps/compat-xii-sanctioned-recovery-I-execution"
REFACTOR="D:/code/screeps/screeps-bot"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
# SECRET 设为此前使用的凭据文件绝对路径，不在日志中打印内容。
test ! -e "$WORK" || exit 1
mkdir "$WORK"
node "$PKG/tools/verify-package.cjs" || exit 1
node "$PKG/tools/run-tests.cjs" --run "$RUN" --out "$WORK/tests" || exit 1
```

必须得到 `RECOVERY_OFFLINE_TESTS_VERIFIED`，52/52；测试使用真实原始 snapshot，网络测试只连接 127.0.0.1 临时服务器，不连接 Screeps。测试不会改动原 run 文件。

实际执行前自主确认旧 collector、guard/recovery-worker 和 observe 父进程已经退出，且没有其他上传任务、网页 IDE 编辑器或自动部署器并发操作 default。原进程退出凭据在 run 中；不要仅因 PID 当前被复用就杀进程。关闭/停止的是能确认归属原实验的任务，不是任意相同 PID。发现未确认的并发写入就停止，不假装 exclusive。

若出现 NODE_PATH/NODE_OPTIONS/DEST/DEPLOY_ALLOW_DIRTY/TLS 绕过设置，先消除运行环境注入，不能改包禁用检查。不得关闭 TLS 验证。

## 3. 唯一新的恢复写入入口

```bash
node "$PKG/tools/recover.cjs" \
  --run "$RUN" --tests "$WORK/tests" --secret "$SECRET" \
  --execute --exclusive-target --prior-workers-stopped \
  --authorize-additional-restore \
  > "$WORK/recover-result.json" 2> "$WORK/recover.stderr"
```

恢复规则：

- 先取得两次连续成功的完整身份读取，检查账号、唯一 activeWorld、default 完整 typed modules。整个读取循环有 10 分钟总截止，单次大 modules GET 最大 60 秒，不依赖 overview、game/time 或房间可见性。
- 已是旧生产：零 POST，进入运行确认。
- 仍是精确候选：在共享 action.lock 内再次读回，成功后先 fsync 新 attempt marker，再发出最多 1 次恢复 POST。写请求最多等待 120 秒，无自动重发、无重定向。
- 第三种代码、账号错误或 activeWorld 改变：拒绝写入。身份读取不是服务端 CAS，因此其他外部写入方必须保持停止；不能把本地 action.lock 宣称为跨客户端原子保护。
- POST 成功、超时、断连都继续用 GET 对账。网络错误不等于服务端未执行，也不能据此自动再次发送。
- 新 marker 位于原 RUN 下固定的 `sanctioned-recovery-I-2026-09-20/restore-attempt.json`。改变 WORK 不会刷新配额。崩溃发生在写 marker 之后、实际发送之前，也保守视作配额已消耗。
- 原 RUN/restore-attempt.json 不修改；本包不调用旧的 restoreOnce。
- 取得稳定旧生产字节后，开启全新的 WebSocket closure，连续确认 75 秒 shard1 console 与账号级 CPU，要求正 CPU、无桥报告、无意外构建日志，最后再次独立读取旧生产字节。新日志不能补充原实验样本。

结果文件和原始读回/运行证据在固定 ledger 下的 `invocation-<id>/`；不覆盖旧 invocation。完整程序最多经过四段各 10 分钟的只读检查、一次 120 秒写等待及一次最长 60 秒就绪 + 75 秒运行确认；均是有界前台执行，不作后台承诺。

## 4. 非成功、崩溃与续接

`RESTORED_BYTES_AND_RUNTIME_VERIFIED` 是唯一恢复全闭环成功标签。`RESTORED_BYTES_CONFIRMED_RUNTIME_UNCONFIRMED` 只能证明某次读取确认了字节，不能宣称运行闭环成功。

如新 POST 已标记但结果未确认，只允许下面的只读续接；它不会发送 POST，允许旧 action.lock 因崩溃遗留时做对账，不删除该锁：

```bash
node "$PKG/tools/recover.cjs" --run "$RUN" --secret "$SECRET" \
  --reconcile-only > "$WORK/reconcile-result.json" 2> "$WORK/reconcile.stderr"
```

同一新增授权不会再次发送 POST，即便重新执行 write 入口也只能读取。但不要靠重启反复消耗网络循环；至多进行上述一次只读续接，其后仍未确认则保留证据停止，不能再开 recovery-II 或手改 marker。

如 action.lock 仍在，发布器会拒绝归档；先保留进程/锁证据报告阻塞，不自动删除无法证明失效的锁。未发出新增 POST 的瞬态失败也不得现场改实现或更换身份锁。

## 5. 独立验证、证据归档与发布

无论恢复成功还是未确认，正常退出且无残留动作锁时执行归档。只提交 refactor 的新 evidence 目录；compat 保持原 HEAD，不生成源码或 config 提交。

```bash
node "$PKG/tools/archive.cjs" \
  --run "$RUN" --tests "$WORK/tests" --secret "$SECRET" \
  --refactor "$REFACTOR" --compat "$COMPAT" --push \
  --out "$WORK/publish-result.json" \
  > "$WORK/publish.stdout" 2> "$WORK/publish.stderr"
```

发布器会重新验证：原输入、唯一新增写入边界、实际字节证据、完整运行日志和前后时间顺序；secret scan；归档清单；原生 staged whitespace；暂存 blob；唯一 evidence commit；普通 fast-forward push 和远端读回。不通过验证不能把原结果改成成功。GitHub 网络失败时只可重跑同一 archive 命令的幂等发布，不再次执行在线恢复。

证据目录：
`openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-xii-retry-i-sanctioned-recovery-i/`

私有 backup.json、candidate.json、dist/main.js、source map、凭据都不入库。本 ZIP 不含这些字节。请保留原 execution 目录和备份，不能根据“11/11 任务完成”提前删除恢复材料。

## 6. 最终报告

分别报告恢复状态、原诊断状态、实际新增 POST 次数、是否消耗新 marker、恢复前后 main/digest、独立运行时长、两条分支最终 HEAD、证据提交。原始实验仍保持 `CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE`、完整样本 0、`ENGINE_CPU_BUDGET_GAP_UNRESOLVED`。不得生成新观测、完整 Treasury 切换或 12 点通过结论。

CPU 归因修正：原 console 实际有 3 条 raw，只有前两条被验证器接收。第三条 tick 73830700 prefix 20.9204398、commitmentBuild 19.1933352，触发 5 CPU 诊断安全阈值。第一条 commitmentBuild.calls=0，0.0281073 不是一次真实 commitment 构建成本。该分析不改变原验证结果，也不是本恢复包的优化任务。
