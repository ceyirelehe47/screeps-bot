# Observation 0003 · Recovery & Evidence Remediation I

## 0. 本轮目的与边界

本包是完整实现交付。执行 Agent 仅核验文件、运行固定测试、填写真实路径、执行一次受控恢复闭合、离线回放、归档和线性提交。不得现场写代码、改用例、改超时/重试次数、提高 CPU 预算、启用新观察窗口或为了成功标签改写原始日志。

**优先事项是确认并闭合 0003 的线上恢复。** 旧证据显示候选上传并回读成功，恢复前读取失败，归档中没有恢复写入标记；这不是当前线上状态的保证。新命令先读当前模块，只有仍逐字节等于本轮候选、原运行目录没有任何恢复尝试标记、目标排他使用且旧进程全部退出时，才允许消耗 0003 尚未使用的那一次恢复 POST。若已是原件，零 POST；若是第三方代码或状态读不清，零 POST。

本轮不部署任何新候选，不运行旧 `observe.cjs`，不生成 0004，不修改兼容分支或 Treasury 生产源码。旧 0003 观察始终是 `ONLINE_COMPAT_READ_INCONCLUSIVE`。重新解码首点不等于收齐 12 点，也不等于 CPU 问题已修复。

本包通过新的、恢复专用的 75 秒 console/CPU 采集通路补充运行确认。该通路具有独立 closureId；与旧 collector 不拼接，不回填旧窗口，不把重启后的数据当成连续观察。代码字节恢复和运行确认分别报告。旧正式执行入口的失败分支不再被调用。

## 1. 固定对象和执行前状态

| 用途 | 固定值 |
|---|---|
| refactor HEAD | `6e4ec0e49c01eed2c130191459cd26b8a1c41257` |
| compat HEAD，默认 OFF | `3292e152b0db465263e4f1fa5c9eac068394acef` |
| compat 完整 tree | `cc2f08f676f28a329a78c971e7b066bb83b49658` |
| 原 0003 runId | `52ec356bc4c01aaf4197f2962beea646` |
| 原候选 HEAD | `d895423b8226d41b6352e1723695e1326fc3e69a` |
| 原 run tree，29 文件 | `5afeca2ba5923aa0837d9b8309d0d11925f75f34` |
| 原生产 BUILD_COMMIT | `06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c` |
| 原生产 main SHA-256 | `37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b` |
| 候选 main SHA-256 | `96fff4fc01c946bf8303955eb73a7723abcda89f7dc7221857d26541e657d182` |

使用原生 Node 22，既有 Windows Node 22.19.0 可用；不要求 WSL、不要求大小写敏感目录、不需要安装 npm 依赖。运行目录、解压包与测试输出均须位于 Git 工作树外，且彼此分离。`NODE_OPTIONS`、`DEST`、`DEPLOY_ALLOW_DIRTY` 应未设置。

先确认 0003 的旧 driver / recovery worker / collector 已退出。只检查已知的 PID/本轮进程记录，不归档全机器进程命令行。不杀死仍在安全收尾的恢复 worker。若仍有旧 worker、`action.lock` / `guard.lock` / `collector.lock`，停止并报告；**不能删锁或重建原 run**。

确认 `screeps.com` / `forster` / `default` 目标没有其他人工 push、watch 或部署自动化。接口无服务端 CAS；排他使用不能由本工具自行证明。无法真实确认时，不传写权限确认标志，只允许使用本书的只读分支。

## 2. 路径变量、包验证和基线

下列路径只是示例，按原有工作树和 0003 现场填写。`PRIOR` 必须是那次真实运行的目录，里面原有 `backup.json`、`candidate.json`、`public-session.json`、上传回执应完整。**不要用 Git 归档目录代替 PRIOR，不要复制一份 run 来清空恢复标记。**

```bash
PKG='D:/code/screeps/0003-recovery-package'
REF='D:/code/screeps/screeps-bot'
COMPAT='D:/code/screeps/compat-worktree'
PRIOR='D:/code/screeps/obs0003-live/run'
SECRET='D:/code/screeps/.secret.json'
WORK='D:/code/screeps/0003-recovery-remediation-I'
```

`SECRET` 永远是文件路径，不是 token；不把 token 放进命令行或聊天。旧原件缺失时停止，不从其他轮备份猜测、不从源码重新构建“等价备份”。本工具会按原公开 session 的 SHA-256 验证两个私有快照的完整文件字节，并使用固定 canonical deployGuard 检查模块内容。

核验公布的 ZIP SHA-256，完整解压。`WORK` 必须尚不存在；若存在，保留它并停止，不 `rm -rf`、不换名字重试线上步骤。在新建 WORK 前可先检查目录；工具的各输出子目录也必须不存在。

从两个既有工作树执行 `git fetch origin`，不要 reset/rebase/force push。随后：

```bash
mkdir -p "$WORK"
node "$PKG/tools/check-baseline.cjs" --refactor "$REF" --compat "$COMPAT"
node "$PKG/tools/run-tests.cjs" --out "$WORK/tests"
```

固定测试必须 80/80，fail/skipped/todo/cancelled 全为 0。原始 TAP、stderr、exit 与环境摘要自动保存。任一离线测试失败即停止，不调用 Screeps、不让 Agent 修绿。测试仅使用临时 Git、loopback HTTP、模拟 WebSocket 和假凭据。不要重跑生产 195/685、92 项旧工具测试或 25 分钟联合探针；本轮生产代码不变。

## 3. 从固定 Git 对象物化原始证据

```bash
node "$PKG/tools/materialize.cjs" --repo "$REF" --out "$WORK/source"
```

输出为 `$WORK/source/run` 的 29 个原始文件与单独 MANIFEST。来源为固定 commit/tree/blob，重新计算 Git tree 身份；不是信任当前工作目录。完整 backup/candidate 不在这组 Git 证据中，恢复时只从 PRIOR 读取，绝不复制进新证据。

## 4. 唯一一次恢复闭合入口

前提：固定测试通过、私有原件存在、已确认旧进程退出、已确认排他使用。执行一次：

```bash
node "$PKG/tools/close-0003.cjs" \
  --refactor "$REF" --compat "$COMPAT" \
  --source "$WORK/source" --prior-run "$PRIOR" \
  --tests "$WORK/tests" --secret "$SECRET" \
  --out "$WORK/closure" \
  --execute-recovery --exclusive-target --prior-workers-stopped
```

该命令不选择新窗口，也不上传 OFF 构建。自动过程已经实现：

1. 按原 Git 证据与文件 SHA 核验 PRIOR 的两份私有模块快照和上传回执，拒绝错误 run、缺失原件、原件替换或损坏恢复标记。
2. 先用只读 me / branches / code / branches 核验账号、唯一活动分支和模块。**不把 tick、overview 或旧 profile 尚未过期作为恢复前提。** 每轮最多 3 次完整读流程，单请求最多 8 秒，读失败退避 2 秒/5 秒；错误记录具体阶段与稳定错误码，不存 HTTP body、header、原异常 message/stack。
3. 若当前模块是原件，不发送恢复 POST；若为第三方代码或无法确认，停止写入分支。
4. 若当前模块是本轮候选，在原 `action.lock` 下再次核验。只有原 `restore-attempt.json` 不存在时，排他创建并 fsync 同一个原标记，随后最多发送一次恢复 POST。标记写入失败不发请求。已有标记无论上次响应如何都不重发，不删标记、不换目录绕过。
5. POST 仅能发送已锁定的旧生产原字节。响应超时/连接错误不代表未发送，不自动重试。随后通过新的有限只读回读确认当前字节；丢失 POST 响应但独立回读确认原件时，会保留原响应不确定性，并据当前字节作恢复判断。
6. 字节确认后，建立**新的恢复专用** WebSocket，读取同账号的 shard1 console 和账号级 CPU。鉴权/双通道就绪后按 monotonic clock 持续至少 75 秒，要求期间双通道新鲜并取得就绪之后的正 CPU 帧。不要求捕获已可能错过的恢复部署公告，不据此声称 CPU 帧自带 shard 信息。
7. 运行采集无自动重连；观察到关闭、鉴权重复、桥报告或通道过期时，运行确认失败，但仍执行最终只读代码回读，不抹掉已取得的字节恢复证据。
8. 独立 verifier 从新的原始 console JSONL 重算认证、PID、边界、时长、通道间隔及正 CPU 证据，结合运行前后字节摘要给出最终裁决。旧 0003 的失败 collector/guard 报告不改写。

退出码 0 表示 `RECOVERY_CLOSURE_VERIFIED`。退出码 2 表示有完整的非成功/部分成功裁决，必须如实报告。普通异常为 1。若输出损坏、部分结果文件未能生成或归档器拒绝，保留部分现场并报告；不得手工补齐成功文件。不得因非零退出而补发恢复请求；也不得为了任务停止而强杀处于 POST 或回读收尾中的进程。

### 无法确认排他权限时的只读分支

不要勾选不真实的确认标志。可运行同一入口但不带三个末尾的权限标志，并使用仍未存在的 `$WORK/closure`；只做只读状态对账，不 POST、不启动运行确认。结果通常为 `RESTORE_STILL_REQUIRED` 或 `RESTORED_BYTES_CONFIRMED_RUNTIME_UNCONFIRMED`。使用了这条分支后，本任务不再启动第二次 closure。将缺少的权限前提和结果返回，等待新的明确安排。

## 5. 恢复裁决含义

| 结果 | 可以说什么 |
|---|---|
| `RECOVERY_CLOSURE_VERIFIED` | 新的字节回读与恢复专用运行证据均通过，原观察依旧 INCONCLUSIVE |
| `RESTORED_BYTES_CONFIRMED_RUNTIME_UNCONFIRMED` | 本轮回读确认原件字节，运行证据不足；不能写完整恢复链通过 |
| `RESTORE_STILL_REQUIRED` | 读到候选；写入未授权、已有标记或恢复后仍是候选；不能补发 |
| `CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT` | 读到第三方代码，不覆盖 |
| `ONLINE_CLOSE_UNCONFIRMED` | 读取失败或证据不足，不能推断已恢复 |

任一非成功都禁止再次运行 closure/观察。**恢复步骤已经生成终态后，仍允许完成以下离线回放和失败归档**；这不构成重复线上尝试。若在原件核验阶段就失败、没有生成 closure 目录，只保留外部安全错误输出并停止，不强行凑齐归档。

## 6. 离线解码修复与 CPU 证据

```bash
node "$PKG/tools/replay.cjs" --source "$WORK/source" --out "$WORK/replay"
```

解码器支持命名实体、十进制及十六进制实体（含 `&#x22;` / `&#X22;`），只解一层；原始合法 JSON 优先原样解析。不得递归解码、修补残缺 JSON 或删除不合格报告来制造成功。

固定 Git 原始日志的预期结果：收到 1 条报告，tick `73646500`，完整合格样本 0；原始未收到的点 11，缺少完整样本的点 12。四个端点 direct/core 选定范围匹配，但 status 为 `partial_cpu_budget`，commitments 为 `not_read_cpu_budget`，输出前 CPU 为 `2.4981476000029943`，原预算为 `2`。这些应同时保留，而不是只留下 `SAMPLE_NOT_COMPLETE`。

本轮的 CPU 交付是固定证据整理，不是预算校准或性能优化。原报告没有子阶段计时，也没有首点的后继完整成本，因此冷启动、加载、observation 构建各自成本及序列化/输出后的完整成本均未知。Agent 不新增 profiler、不写生产补丁、不提高预算、不再连接引擎来补测。

## 7. 白名单归档和唯一提交

全部在线过程已退出、保留原状态之后：

```bash
node "$PKG/tools/archive.cjs" \
  --refactor "$REF" --compat "$COMPAT" \
  --source "$WORK/source" --closure "$WORK/closure" \
  --replay "$WORK/replay" --tests "$WORK/tests" --secret "$SECRET"
```

归档器重算恢复证据，只复制新恢复的白名单证据、回放分析、测试、完整任务包和原 source 的哈希清单。不会递归复制 PRIOR；不会复制 backup/candidate/session/凭据。对全部归档输入做 token 原值、URL 编码、8/16 字符前缀扫描；命中则停止，不打印命中原文。

唯一新增的 Git 目录：

`openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/online-observation-0003-recovery-remediation-i/`

目录内 `.gitattributes` 使用 `* -text` 保持证据字节，防止 Windows autocrlf 改写 stderr 等原件。不会更改仓库根属性或生产文件。暂存后由工具从 Git index 再校验每个文件字节：

```bash
TARGET='openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/online-observation-0003-recovery-remediation-i'
git -C "$REF" add -- "$TARGET"
node "$PKG/tools/verify-archive.cjs" --refactor "$REF" --compat "$COMPAT" --staged
git -C "$REF" commit --no-gpg-sign -m 'evidence(compat): close observation 0003 recovery and replay escaped first report'
node "$PKG/tools/verify-archive.cjs" --refactor "$REF" --compat "$COMPAT" --after-commit
git -C "$REF" push origin HEAD:refs/heads/refactor/empire-treasury-rearchitecture
```

推送前核对远端仍为固定 base；发生其他提交则停止，不强推、不 amend、不改历史、不自动合并。推送失败只报告本地提交 SHA 和实际错误，不重跑线上步骤。compat 始终保持 `3292e152…`，不产生提交。

## 8. 最终回复

报告测试 80/80 与真实 Windows/Node 环境、两个最终 HEAD、push 结果、当前字节对账、恢复 POST 实际次数及原响应、75 秒新恢复采集的实际结果、原件完整性和解码回放的 1 条收到/0 条完整。

完整恢复闭合通过时可使用：

```text
RECOVERY_CLOSURE_VERIFIED
DECODER_REPLAY_VERIFIED
CPU_BUDGET_GAP_RECORDED_NOT_REPAIRED
ONLINE_COMPAT_READ_INCONCLUSIVE
NO_NEW_CANDIDATE_UPLOAD
```

只有恢复成功的部分才能使用其标签。不能把恢复 POST 说成新观察上传，不能把“无新候选”说成“本轮绝无代码写入”。不能使用 `ONLINE_COMPAT_READ_OBSERVED`、`TREASURY_PRODUCTION_READY`，也不能宣称 CPU 优化或旧正式执行链已经全面验收。
