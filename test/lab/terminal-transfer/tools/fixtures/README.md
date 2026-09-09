# 固定回归资料来源

基线仓库：`ceyirelehe47/screeps-bot`，提交 `d69726a92d46c3ab334355a6625ef253c1523a86`。

`review-base-facts.json` 是该提交下以下文件的逐字节副本：
`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i-calibration-rerun/engine-run/s02-calibration-facts.json`。
Git blob SHA：`acfbb51894d268d288480ddc2e9a1c8ad4411a9f`。

`review-base-config.json` 是同一提交 `test/lab/terminal-transfer/labConfig.ts` 实际 `LAB_EXAMPLE_EXPERIMENT` 常量的 JSON 表示；原 TS blob SHA：`357543a08e7ab899c73339f5b94f91ceb2379f50`。

这两份分别来自旧配置与独立实测资料，用于固定回归；配置不是由基线事实反向生成的。故障样例只在内存深拷贝上修改，并断言文件字节不变。未来新世界绑定改变时，不将本目录旧资料同步改成新身份。测试用 `codeSource` 字符串是合成来源占位，不冒充新实验源码身份。

旧运行 cal-0002 在 T201 没有有效控制记录，结论仍是 INCONCLUSIVE。本目录合法预检对照通过，只能证明这些历史输入通过比较函数，不能证明旧实验曾武装、send 或转运成功。
