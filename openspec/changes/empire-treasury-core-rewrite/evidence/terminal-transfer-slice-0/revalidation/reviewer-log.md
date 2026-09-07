# Terminal Transfer Slice 0 — 第二上下文定向复验 reviewer 日志

- 复验日期：2026-09-07（本地时间，Windows / Git Bash）
- 复验提交（VALIDATION_HEAD）：`0ce9d971bcf72daf19a1fe68fd7bb384e4db56fe`
- 仓库：`D:/code/screeps/screeps-bot`（分支 `refactor/empire-treasury-rearchitecture`）
- 独立 worktree：`C:/Users/15027/AppData/Local/Temp/slice0-review/worktree`（`git worktree add --detach 0ce9d97`）
- 输出根：`C:/Users/15027/AppData/Local/Temp/slice0-review/output`（仓库外；Jest cache 独立于 `output/jest-cache`）
- 环境：node v22.19.0；npm 10.9.3
- 身份声明：本 reviewer 未参与本轮实施，仅执行本复验。
- 约束遵守：未在主工作树运行任何测试或修改任何文件（主树 porcelain 前后均为 0 行）；未 commit/push；未运行 `npm run push`/`npm run local`；未调用真实游戏 API；`npm ci` 按 lockfile（896 包，lockfile diff 0 行）；全部命令真实执行并保存 `.command.txt`/`.log`/`.exit-code.txt` 与 Jest JSON 原件。

## 时序与结论

| # | 步骤 | 产物前缀 | 退出码 | 结论 |
| --- | --- | --- | --- | --- |
| 0 | `git worktree add … --detach 0ce9d97` | （见本日志） | 0 | worktree 建立，HEAD=0ce9d97 |
| 1 | 前置 `git rev-parse HEAD` | head-before | 0 | `0ce9d971bcf72daf19a1fe68fd7bb384e4db56fe` |
| 2 | 前置 `git status --porcelain` | status-before | 0 | 空（干净） |
| 3 | `node --version` / `npm --version` | node-version / npm-version | 0 | v22.19.0 / 10.9.3 |
| 4 | `npm ci --no-audit --no-fund` | npm-ci | 0 | 896 包；worktree 仍干净、lockfile 未改 |
| 5 | 任务书 SHA-256（仓库副本 + Downloads 原文） | task-brief-hash | 0 | 两份均为 `1d1d835376fb95b5c897511070024085f971b578ab7d05efd96daf15ad6f55f5`，与预期一致 |
| 6 | `npx tsc --noEmit -p tsconfig.json` | typecheck | 0 | 通过 |
| 7 | 生产冻结 diff（src，排除 *.test.ts/*.spec.ts，基线 869149d） | production-freeze | 0 | 零差异 |
| 8 | 配置冻结 diff（package.json/package-lock.json/rollup.config.js/tsconfig.json/tsconfig.build.json/jest.config.cjs） | config-freeze | 0 | 零差异 |
| 9 | M 集合 Jest（Slice0 单文件） | jest-slice0 | 0 | 1 suite / 8 tests / 8 passed / 0 fail / 0 pending / 0 todo / 0 runtime error（=预期 8/8） |
| 10 | KEY 六件 Jest（首次，轨迹落 output/trace-key） | jest-key | 0 | 6 suites / 65 tests / 65 passed（数字见 jest-key 产物；该次 JSON 后被步骤 10b 取代为驱动输入布局，原件目录保留） |
| 10b | KEY 六件 Jest（重跑，落 run-key 模板布局） | jest-key-rundir | 0 | 6 suites / 65 tests / 65 passed（`run-key/jest-key.json`；与步骤 10 数字一致） |
| 11 | Defense 十一件 Jest | jest-defense | 0 | 11 suites / 118 tests / 118 passed（=任务书上轮口径 11/118） |
| 12 | 核验驱动正例（attempt1，按指令文件字面路径） | verify-evidence-attempt1 | 1 | **失败，见异常 A1** |
| 13 | 核验驱动正例（run-key 模板布局） | verify-evidence | 0 | `TREASURY_EVIDENCE_VERIFY=PASS (0 failures)`；H18-J06 轨迹 bytes=1180356 sha256=f843a15f…d9a8d3 completed=true checkpoints=54 problems=0；jest-key 6/65/65 |
| 14 | 核验驱动负例（零输入：空 run-dir） | verify-evidence-empty | 1 | 非零，FAIL 2 条（无 trace 目录、无 Jest JSON） |
| 15 | 核验驱动负例（缺 `--fixture`） | verify-evidence-noargs | 2 | 非零（用法错误，退出码 2） |
| 16 | 后置 `git rev-parse HEAD` | head-after | 0 | 仍为 `0ce9d971…db56fe` |
| 17 | 后置 `git status --porcelain` | status-after | 0 | 空（干净） |
| 18 | 主工作树只读 status 检查 | （本日志） | — | 0 行，未被改动 |
| 19 | `git worktree remove` | （本日志） | 0 | 见下"清理" |

## Jest 数字汇总（自 JSON 原件读取）

- M 集合（`jest-slice0.json`）：suites 1 / tests 8 / passed 8 / failed 0 / pending 0 / todo 0 / runtimeErrors 0
- KEY 集合（`run-key/jest-key.json`，与首次 `output/trace-key` 目录内 JSON 同口径）：suites 6 / tests 65 / passed 65 / failed 0 / pending 0 / todo 0 / runtimeErrors 0
- Defense 集合（`jest-defense.json`）：suites 11 / tests 118 / passed 118 / failed 0 / pending 0 / todo 0 / runtimeErrors 0

## 异常与处置（如实记录）

- **A1 核验驱动正例首跑失败（exit 1）**：按指令文件第 29 行的字面建议以 `--run-dir <OUT>/trace-key` 运行时，驱动报 `run-dir 下不存在任何 trace 目录（trace-key/trace-treasury/trace-full/trace-budget 至少一个）——零输入`。阅读 `scripts/verify-treasury-evidence.mjs` 源码（第 50、140、196-200 行）确认其契约：`--run-dir` 下须存在名为 `trace-key` 等之一的**子目录**（内含 `H18-J06.json`），且 Jest JSON 须位于 run-dir 根部。指令文件的路径建议与驱动契约不一致；任务书 §7.2 主验证模板的布局（`$OUT/trace-key/` + `$OUT/jest-key.json`，`--run-dir $OUT`）才是正确口径。
  **处置**：失败首跑产物保留为 `verify-evidence-attempt1.*`；新建 `output/run-key/`（含 `trace-key/` 子目录与 `jest-key.json`），以相同命令与相同环境变量重跑 KEY 六件（步骤 10b，产物 `jest-key-rundir.*`，数字与首次完全一致）后重跑正例，exit 0。原 `output/trace-key/` 目录（首次 KEY 运行的轨迹与 JSON）原样保留作对照，未删除。
- 无其他异常：npm ci、typecheck、两组冻结 diff、三组 Jest、两个负例均一次通过/按预期返回非零；全过程中 worktree 与主工作树均未被弄脏。

## 清理

- 后置 status 干净（步骤 17）后执行 `git worktree remove C:/Users/15027/AppData/Local/Temp/slice0-review/worktree`（node_modules 为 worktree 内自生），**退出码 0**（产物 `worktree-remove.*`）。
- 复核：`git worktree list` 仅剩主树 `D:/code/screeps/screeps-bot`（HEAD `0ce9d97`，分支 `refactor/empire-treasury-rearchitecture`）；`C:/Users/15027/AppData/Local/Temp/slice0-review/` 下仅余 `REVIEWER-INSTRUCTIONS.md` 与 `output/`，worktree 目录已完全移除。
- 产物全部保留于仓库外 `output/`，未向分支提交或推送任何内容。

## 产物清单（output/ 下）

- 环境与状态：`head-before.*`、`status-before.*`、`node-version.*`、`npm-version.*`、`head-after.*`、`status-after.*`
- 安装：`npm-ci.*`
- 任务书核对：`task-brief-hash.*`
- 类型与冻结：`typecheck.*`、`production-freeze.*`、`config-freeze.*`
- Jest 原件：`jest-slice0.json`、`jest-defense.json`、`run-key/jest-key.json`（另有首次 KEY 运行 `trace-key/jest-key.json` 与两次轨迹目录）
- 核验驱动：`verify-evidence-attempt1.*`（失败首跑）、`verify-evidence.*`（正例）、`verify-evidence-empty.*`（零输入负例）、`verify-evidence-noargs.*`（缺参数负例）
- 辅助：`run-step.sh`（统一产物保存执行器，仓库外）
