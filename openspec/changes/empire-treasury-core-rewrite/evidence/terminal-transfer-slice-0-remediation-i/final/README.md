# final/——固定 VALIDATION_HEAD 主验证产物（4ea56d0）

- 主验证脚本原件 run-mainval.sh（sha256 见 run-mainval.sha256.txt）与完整运行日志 mainval-run.log（哨兵 MAIN_VALIDATION_DONE、wrapper-exit=0）。
- 冻结三组（production/config/defense diff --exit-code 均 0）+ changes-this-round.txt（93a6152..4ea56d0）与 changes-from-freeze.txt（869149d..4ea56d0）。
- typecheck/typecheck-build/build 均 0；bundle-sha256.txt（构建含时间/身份，仅产物追溯；生产冻结以 diff 为准）。
- Jest 五组：jest-slice0 2/16、jest-key 7/73、jest-treasury 34/590、jest-defense 11/118、jest-full 238/1436（全 0 failed/pending/todo/runtime error；四份大 JSON 同时被 verify-evidence 驱动复核）。
- budget：JEST_TEST_BUDGET=PASSED 238/1436（脚本自带全仓重跑单列——其内置重跑输出在 budget.log 内，不覆盖主 jest-full.json）。
- verify-evidence：TREASURY_EVIDENCE_VERIFY=PASS（trace 四目录 + 四 Jest JSON，固定 H18 夹具）。
- T1/N07：verify-outside（仓库外**含空格** foreign cwd/ 以绝对路径+绝对 run-dir 运行，exit 0 PASS）；verify-empty（空输入目录，exit 1——"零输入"双失败项）；verify-tampered（trace-key 副本篡改 unknownIds[0]，exit 1——失败原因精确为"fixture.unknownIds 与固定夹具约束不符"，篡改检出）。tampered-input/ 与 empty-input/ 原样保留。
- 状态：status-before/after.txt 均 0 行；head-after=4ea56d0=VALIDATION_HEAD。
- 退出码约定：run() 写 <name>.exit-code.txt；正例组全 0，负例组（verify-empty/verify-tampered）非零为通过条件（脚本内 test -ne 0 断言）。

- 缺参 exit 2 证据位于 revalidation/（reviewer 含空格外目录缺参运行 log，exit=2）与独立验收亲跑记录（主报告 §7）——§9 模板未要求 final/ 自包含该项。
