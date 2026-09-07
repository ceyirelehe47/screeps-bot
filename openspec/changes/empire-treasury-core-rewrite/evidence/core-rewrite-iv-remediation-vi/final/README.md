# Remediation VI 最终验证产物（固定 HEAD 2e15fe375a3be9c4c829d4984ba9528e13877191）

全部为 Agent 本地验证（无独立 CI；node/npm 版本见同名文件）。命令与
exit code 见 commands.txt；关键产物 sha256 见 sha256.txt。

## 结果一览

| 项 | 产物 | 结果 |
| --- | --- | --- |
| typecheck | typecheck.log | exit 0（无输出） |
| build | build.log + bundle-sha256.txt | exit 0；`dist/main.js` sha256 `2cee7a92b3f7f473eb63e00db26a1633e481f8cd5a74bd7c237670b604da5ae4`（上轮 fcc5382d…为历史，非本轮产物） |
| Treasury 定向 | jest-treasury.json/.log | exit 0：**32 suites / 569 tests** 全过（IVKernel 12[含新 H18×3]、VIKernel 9[J01–J04] 为本轮新增/重写） |
| Defense 冻结集合 | jest-defense.json/.log | exit 0：**11 suites / 118 tests** 全过；7 个冻结生产文件零 diff |
| 全仓 | jest-full.json/.log | exit 0：**236 suites / 1415 tests**；failed/pending/todo/runtime errors = 0 |
| budget | budget.log | `JEST_TEST_BUDGET=PASSED`（manifest 236/1415、锚点 b8fc019）；budget 自带全仓重跑的 summary 在 budget.log 尾部（临时 results.json 已被清理，逐用例明细以 jest-full.json 为准——两者在同 HEAD 收集，计数一致 236/1415） |
| 工作树纪律 | status-before/after.txt、head-after.txt | 验证前后 status clean；HEAD 未移动（= validation-head.txt） |

## J 项轨迹摘录

- `i13-cost-excerpt.txt`：I13 四成本 fixture 最终验证真实重跑实测（空 endTick 7读/1写；恢复 A+清理 8C：tick1 41读/7写/7份额/2释放、完成 2 tick 逐 tick [4,2]、total 8；发布失败 2 尝试/0 放行；64 混合推进 53读/10写/8份额）
- `h18-trace-excerpt.txt`：J06 实测（initial 64/90 义务 → 12 tick 观察段逐 tick healthy/份额 8/释放 ≤4 → bounded-ticks=13（上界 40）→ recovery-ticks=1 → final 20 unknown/ring 44/义务 0/active 20）

## 提交链（commits-ahead.txt）

`335b06d`（R1 生产）→ `b8fc019`（V1 测试 + J 矩阵）→ `c1f61ba`（budget）→ `2e15fe3`（openspec 文档 + baseline/negative-variants 证据）＝固定验证 HEAD。主报告见上级目录 `core-rewrite-iv-remediation-vi-local-validation.md`（本目录为非执行证据后置提交，不含可执行脚本）。
