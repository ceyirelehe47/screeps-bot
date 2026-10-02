# 国库 T2 候选交付入口

本轮完成 UH 首片候选工程；生产观察已在 2026-10-02 18:20:24（北京时间）结束。核验时 UH2O 目标 2385、成品 1885、UH 原料 500，实际 UH 新补料缺口为 0，因此没有生产代码上传、arm 或 Treasury native。原 pending1715 不代表当前真实需求。没有后台观察或自动后继接管。

本包只面向 E4N58→E1N57、UH、既有 automatic UH2O 补料任务的一次首片，最多100 UH、100 Energy手续费。它不启用持续自动国库，也没有切到OH。

- 产品源：`a84275040d4f8f8bfea2135a8465608f97637c22`；分支 `codex/treasury-t2-first-production`。
- 最终 main：`a33ca56e530060f0e719630324bfe3d55649786ff19525483fd04197d315653f`，3308853 字节；ZIP根目录 `candidate/main.js`。
- 产物与发布约束：`release-manifest-T2.json`。
- 业务停点与现场投影：`business/现场业务诊断.md`。
- 相关回归：`tests/产品回归结果.md`；精确依赖锁后 `locked-final-combination.json`，38组347项通过。
- 同字节实机：`engine/README.md`、原件与 `engine/tools/verify-evidence.py`。
- 独立产品审查见 `independent-product-review.md`；生产工具审查见 `tools/review.md`。

## 复核方式

从正确远端取回上述精确产品提交后，按 lock安装、typecheck和相关回归。冻结 main有构建时间身份，重建会产生新字节；不要用重建 main替换本次已验证候选。可在ZIP中运行：

```bash
python3 evidence/engine/tools/verify-evidence.py --root evidence --candidate candidate/main.js --manifest evidence/engine/candidate/manifest.json
```

正式服的完整 Memory/code备份在本机私有audit目录，未收入此包。公开原件仅含必要业务投影；隔离原始Memory是合成世界。临时只读Game投影结果键与skill shard probe已经清理，不等同于“从未写任何线上Memory”。

后续必须重新读取真实业务，确认同范围任务仍有未覆盖的UH需求、权限与当前代码匹配，才能决定新生产阶段。本包不会复用旧额度、恢复历史Memory、重试未知动作或因pending存在强行发送。唯一业务后继建议为另立有界OH任务诊断；本轮不执行。
