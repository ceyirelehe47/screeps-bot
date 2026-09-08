# Terminal Transfer Engine Lab Prep I · Remediation I — 第二树独立复验记录（reviewer）

- 日期：2026-09-06（任务书编制 2026-09-08 时间戳体系下的执行记录）
- 仓库：D:\code\screeps\screeps-bot，分支 refactor/empire-treasury-rearchitecture
- VALIDATION_HEAD：`c8a6d53271b269c25c2b83c3f05cecea41433dab`
- 复验人角色：独立 reviewer（任务书 §8.3 第二树复验）
- 输出目录：`C:/Users/15027/AppData/Local/Temp/labprep1-r1-tree2-out`

## 1. 任务书读取

读取 `C:/Users/15027/AppData/Local/Temp/labprep1-r1-evidence-staging/task/task-brief.md` 全文（342 行）。
重点：§3 七场景矩阵（旧产物 S5/S6/S7 = 1/2/2，修复后 = 0/0/0，S2/S3/S4 对照 = 1/1/1）；
§4 发送前标记确认语义（写入→读回确认→send；结果写失败不回滚 attempted）；§8.3 reviewer 职责。

## 2. 干净 detached worktree 与独立 npm ci

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| fetch | `git fetch origin` | exit=0 |
| worktree | `git worktree add --detach C:/Users/15027/AppData/Local/Temp/labprep1-r1-tree2 c8a6d53...` | exit=0，2060 文件检出 |
| HEAD 核对 | `git rev-parse HEAD` | `c8a6d53271b269c25c2b83c3f05cecea41433dab`（等于 VALIDATION_HEAD） |
| 干净核对 | `git status --porcelain \| wc -c` | 0（干净） |
| node/npm | `node --version` / `npm --version` | v22.19.0 / 10.9.3（存 node-version.txt、npm-version.txt） |
| npm ci | `npm ci --no-audit --no-fund`（cwd=tree2） | **exit=0，added 896 packages in 14s，real 15.037s**（npm-ci.log、npm-ci.exit-code.txt、npm-ci.time.txt） |

lockfile sha256（两树一致，见 independence-d.txt / lockfile-sha256.txt）：

```
main-tree:  490ee9c70876f8ab72de2dd497331b9e177f63fe41565a837244401dad9c686a
tree2:      490ee9c70876f8ab72de2dd497331b9e177f63fe41565a837244401dad9c686a
match: YES
```

## 3. 四项独立性核验

| 项 | 文件 | 结论 |
| --- | --- | --- |
| a | independence-a.txt | PASS：node_modules 及 jest/typescript/rollup/ts-jest 子目录 `lstatSync().isSymbolicLink()` 全为 false，实体安装，非 junction/symlink |
| b | independence-b.txt | PASS：tree2 内 `require.resolve` jest/typescript/rollup/ts-jest 全部落 `...labprep1-r1-tree2\node_modules\...`，未落回主树 |
| c | independence-c.txt | PASS：主树 `git status --porcelain` 输出 0 字节，第二树操作未污染主树 |
| d | independence-d.txt | PASS：第二树 lockfile sha256 == 主树（490ee9c7...686a） |

## 4. 五组测试复跑（全部在第二树执行；Jest cache 独立于 OUT：`...tree2-out/jest-cache`）

| 组 | TREASURY_SEAL_EVIDENCE_DIR | 命令（jest.config.cjs，--runInBand） | 结果 | exit |
| --- | --- | --- | --- | --- |
| jest-key | trace-key | 9 文件 --runTestsByPath（probe + Slice0×3 + RemIV/VI/V Kernel/Service） | **9 suites / 97 tests，97 passed，0 failed** | 0 |
| jest-treasury | trace-treasury | `src/runtime/treasury/` | **35 suites / 597 tests，597 passed** | 0 |
| jest-defense | trace-treasury（继承） | 11 文件 --runTestsByPath | **11 suites / 118 tests，118 passed** | 0 |
| jest-full | trace-full | 全仓 | **240 suites / 1460 tests，1460 passed** | 0 |
| budget | trace-budget | `node scripts/verify-jest-budget.mjs` | 内部复跑全仓 240/1460 后输出 `JEST_TEST_BUDGET=PASSED`（manifest test/test-suite-budget.json） | 0 |
| verify-evidence | trace-budget | `node scripts/verify-treasury-evidence.mjs --validation-head c8a6d53... --run-dir OUT --fixture h18` | `TREASURY_EVIDENCE_VERIFY=PASS (0 failures)`；4 个 trace 根 H18-J06.json 均 completed=true checkpoints=54 problems=0；4 个 jest JSON 均解析并核对 failed=0/pending=0/todo=0/runtimeErrors=0；driver sha256=3b5e9464...；verifier-source blob=fd930a44... | 0 |

与预期完全一致：key 9/97、treasury 35/597、defense 11/118、full 240/1460、budget PASSED、verify PASS。

## 5. Q01 两行核对（p01-focus-lines.txt 存两行原文）

`jest-key.log` 中 `Q01-BASELINE` 与 `Q01-FIXED` 各恰 1 行。程序化核对（解析 JSON 后逐场景比对三时点累计 send）：

| 场景 | BASELINE（旧产物） | FIXED（新产物） | 判定 |
| --- | --- | --- | --- |
| S1 未武装/Memory 正常 | 0/0/0 | 0/0/0 | OK |
| S2 正常武装/小记录/写入正常 | 1/1/1 | 1/1/1 | OK |
| S3 send 非 OK/写入正常 | 1/1/1 | 1/1/1 | OK |
| S4 send 抛错/写入正常 | 1/1/1 | 1/1/1 | OK |
| S5 控制槽 setter 抛错 | **1/2/2** | **0/0/0** | OK |
| S6 控制槽 setter 静默丢写 | **1/2/2** | **0/0/0** | OK |
| S7 初始 4090 字符/更新后超限 | **1/2/2** | **0/0/0** | OK |

`Q01-LINES-CHECK=ALL_MATCH`。

如实标注（非缺陷，属任务书 §3 允许并要求如实说明的策略差异）：
- FIXED S5 的 markUnconfirmed 为 `mark_write/assign_failed`（×2），S6 为 `mark_readback/readback_not_attempted`（×2）——静默丢写由真实读回发现；
- FIXED S7 的拒绝发生在**读取阶段**（rejections=`control_record_corrupt`×3，超长 note 记录被形状校验拒绝），属"读取拒绝"路径，未执行到写入超限分支（写入函数对超限候选的拒绝另有针对性断言，见测试套件本身 97 通过）。

## 6. VM 独立复验（reviewer-vm-check.cjs / reviewer-vm-check.log，exit=0）

- 构建：`node scripts/build-treasury-terminal-lab.mjs --mode single-shot --out OUT/reviewer-bundle` → exit=0，产物 24,496 字节。
- 装载：`vm.runInNewContext(bundleSource, sandbox)`（sandbox 仅 module/exports/console/Game/Memory），不依赖仓库 Jest 断言，未修改被测代码。

**场景甲（发送前标记失败：控制槽 setter 抛错、getter 返回合法 armed 记录）**
- 调用序列：loop() 同 tick 12345 ×2，Game.time→12346 后 loop() ×1。
- 结果：**send 累计 0 次**；输出 2 行 `kind=lab-mark-unconfirmed`（stage=`mark_write`，reason=`assign_failed`）；**零** pre-call/boundary/sync 发送边界输出。
- 断言 3/3 PASS。

**场景乙（预标记成功、结果写失败：第 1 次 set 正常存、第 2 次起抛错）**
- 调用序列：loop() 同 tick 12345 ×2，Game.time→12346 后 loop() ×1。
- 结果：**send 累计恰 1 次**，参数 `["H",100,"W10N57","lab-prep1 single-shot terminal transfer experiment"]`（与编译配置一致）；输出 1 行 `kind=lab-result-write-refused`（reason=`assign_failed`，syncResult={ok:true,code:0} 如实记录）；控制槽终态 `{"experimentId":"lab-prep1-example-0001","armed":true,"attempted":true,"attemptedTick":12345}`——**attempted=true 保留、无 stopped 键**（结果写失败未落盘为 stopped、未回滚标记）；后两次 loop 分别被 already_attempted/tick_missed 前置拒绝，零重试。
- 断言 5/5 PASS。

汇总：`REVIEWER_VM_CHECK=ALL_PASS`（8/8 断言）。

## 7. 产物 manifest 核对

`OUT/reviewer-bundle/manifest.json`：

- status = `PREPARED_NOT_RUN` ✓（真实引擎 NOT_RUN 边界保持）
- repoSourceCommit = `c8a6d53271b269c25c2b83c3f05cecea41433dab` = VALIDATION_HEAD ✓
- output.sha256 = `49960ef8d5a147adeb49d6a36ba9df5b56cfd79028918e9be50d522d46f083ca`；实际 `sha256sum single-shot.js` = **同一值** ✓；bytes 24496 与 `wc -c` 一致 ✓
- lockfileSha256 = `490ee9c7...686a` 与两树 lockfile 一致 ✓
- toolchain：node v22.19.0、typescript 5.9.3、rollup 4.59.0 ✓

## 8. 清理

- `git worktree remove C:/Users/15027/AppData/Local/Temp/labprep1-r1-tree2 --force` → exit=0
- `git worktree list` → 仅剩主树 `D:/code/screeps/screeps-bot c8a6d53 [refactor/empire-treasury-rearchitecture]`
- 主树 `git status --porcelain` 0 字节；主树 HEAD = c8a6d53（分支 refactor/empire-treasury-rearchitecture）

## 9. 异常与如实说明

- npm ci 期间出现 3 条 deprecation warning（eslint@5.16.0 等），不影响安装，lockfile 冻结既定状态。
- 除此外无任何异常：无测试失败、无 runtime error、无独立性问题、无断言失败。
- 本复验未执行：npm run push、真实 terminal.send、服务器启动等（任务书 §2 禁止项全部遵守）。
- S7 FIXED 为读取拒绝路径（见 §5 说明），Q01 的"新产物同场景全零发送"结论不受影响。
