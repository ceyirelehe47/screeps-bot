# 任务来源归档说明

本目录归档 Control Remediation I 的实现包原件（用户会话附件
`screeps-control-remediation-I-implementation-2026-09-09.zip`，解包后逐字节复制）：

| 文件 | 说明 |
|---|---|
| `reference-task.md` | 任务书原件（R01 Memory 控制通路 / R02 预检完整性 / R03 及时停止与一次受控复验 S01–S06） |
| `AGENT-VERIFY.md` | 代码应用与独立验收指令（原样补丁→首轮验证→独立增补→预算→正式回归→第二树→实机边界） |
| `README.md` | 实现包自述原件（基线 d69726a、17 文件、边界声明） |
| `source-manifest.json` | 固定起点/原源码 Git blob/补丁 SHA-256/目标文件 hash——应用前已逐项核对一致（含 fixtureProvenance：review-base-facts.json 为上轮归档 s02-calibration-facts.json 的逐字节副本，blob acfbb518…） |
| `changes.patch` | 唯一实现载体（sha256 ac96655c…，17 文件，git apply 原样应用） |
| `apply_patch.py` | 包内应用脚本（--check-only 与实际应用均使用，要求准确基线与干净工作树） |

实现包声明：实现者本地是选定文件重建工作树（非完整仓库、无远端提交）；
本轮实际交付代码以本仓库提交 `b3207f9`（IMPL_HEAD，补丁+Agent 增补）与
`d0103c9`（VALIDATION_HEAD，预算锚点）标识。

应用前核对：仓库 HEAD 与远端均为 d69726a（补丁基线）；calibrationCheck.ts 原始
blob 0c55cb9e、四个 frozenInputs（labConfig 357543a0 / controlRecord 1fb0198e /
worldRead acf69e8e / verify-lab-calibration.mjs 85f77b86）与 manifest 一致；
fixture 字节与归档原件一致；modified-files 的 sha256 抽查与 manifest 一致。
