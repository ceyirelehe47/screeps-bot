# FC1 Online II：巡逻基线兼容副本的离线状态

日期：2026-09-25（Asia/Shanghai）。本目录是旧 FC1 r2 固定执行器的**新发布副本**，旧 pending 包和旧 evidence 没有修改。它只准备 G1 四点测量；G2 Treasury writer 候选在另一独立分支。

## 身份

| 项目 | 已核对值 |
| --- | --- |
| 正确仓库 | `ceyirelehe47/screeps-bot`；`origin` fetch/push 均指向该仓库，原 FC1 参考分支读回匹配。 |
| FC1 固定源码 | `0cdbd061c2645366bd409dbdbd262881d277cb35`；四份 runtime/preview/Core/CPU 模块的源码、生成输出指纹和 `runtimeEmitterId=treasury-full-cost-FC1-online-I-2026-09-24` 未改。 |
| 巡逻兼容源 | `codex/fc1-online-ii-patrol-base`，HEAD `387013b60a7594150b09093d5ef4f9ffd2c05e5c`，tree `25e0b6fb827f131be4c3215a97576f78a34a3455`。第一层提交只移入 `5cef62c5` 的近战文件与测试，文件 blob 与现役修复逐字节相同；第二层只更新 Jest 固定计数。 |
| 正式服备份 | 2026-09-25 01:21:52 读回 `forster/default/shard1`，账号 ID `634fe406347a7b69b28aeccb`，两房均在本账号 overview 中；`main` 4,494,748 字节，SHA-256 `62a993bf917f1a74ef708584eaee1fc3d2deb5aaf8b0c751f8f9d72ff3c08032`，模块集合 hash `50295c19de66f7d34b2bd4e54f08317b212ea3a54054385a2abdeb6ef8aa74fe`。`BUILD_COMMIT=5cef62c5`、`BUILD_TREE=151b77b7`，与巡逻工作树 `dist/main.js` 的 SHA 和字节数相同。原始模块只保存在仓库外私有目录。 |
| 新执行器指纹 | `3af924b890e8d2078c30ed19e092f79df17e754dd06ab460fa130ec59289c0bd`，见 [executor](executor/)。它仍处于 `WAITING_FOR_EXPLICIT_AUTHORIZATION`，线上入口会在 marker 和网络写入前拒绝。 |

冻结测量器日志中的 `productionBase=06ffedb7` 表示它的**测量源码血统**，不是此刻要恢复的正式服字节。本副本用 `measurementSourceBaseCommit` 校验该日志字段，独立用 `backupDigest`、`backupBuild` 校验实际 `5cef62c5` 备份。没有改测量器源码来伪造新的日志身份。

2026-09-25 01:39:47 又执行一次只读正式服核对：账号、活动 branch、两房归属、`BUILD_COMMIT`、部署 tag、模块集合 hash 和 `main` SHA 与上述快照仍完全一致。这只是上传前的当前性检查，正式执行仍须即时重读。

## 离线验证

- 包完整性通过；`source()` 校验旧 FC1 提交、巡逻文件 blob、第二层门禁 blob、新 HEAD/tree、固定 runtime emitter 均通过。
- 执行器分组测试：100 项旧风险回归 + 45 项 FC1 组合测试，共 **145/145**，见 [executor-tests](prepared/executor-tests/result.json)。
- 兼容源码 Node 测试 **499/499**；TypeScript `5.9.3` 的 build/test 两套类型检查、生成器前后校验、本地语义回放通过；Jest **195 suite / 688 test** 全通过，见 [offline](prepared/offline/result.json) 与同目录原始 stdout/stderr。
- build-only OFF 包 4,629,860 字节，SHA-256 `055dd856903e44e32164f7326c1bd073d32f1d79bead0970eae618f31d9bbdcb`，见 [candidate-build.json](prepared/candidate-build.json)。实际线上 ON 候选仍须在择时后绑定四点窗口，由执行器重新构建，不能把 OFF 包当成已上传候选。
- 带 `--execute` 的发布入口在 `NEW_ROUND_AUTHORIZATION_REQUIRED` 停下；未创建工作目录或 Git experiment marker，candidate/restore POST 均为 **0**。

## 未完成与下一边界

G1 线上四点真实业务报告、四份成本回执、完整成本判读、精确恢复与运行确认**均未执行**。现有源分支仅在本地，未推送到正确远端；新执行器仍未取得针对本指纹和现役 `5cef62c5` 恢复字节的一次性线上确认。此前的线上许可只覆盖巡逻修复部署，不能自动扩展为这个新 FC1 发布副本的候选上传。

若批准此副本，先重新读正式服账号、活动分支、房间所有权与完整模块，确认与上述备份精确一致；核查所有相关 Git common-dir 的一次性 marker 与 worker/collector；把授权身份写入**新副本**并重封包、重跑所有门禁。随后只允许一次只读兼容候选 POST、四点各隔 100 tick、一次精确恢复 POST；回包不明只读对账，不能重发或另开窗口。任何前置失败记 `NOT_DEPLOYED`。
