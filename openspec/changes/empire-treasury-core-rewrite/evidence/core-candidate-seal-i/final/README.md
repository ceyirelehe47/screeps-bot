# Core Candidate Seal I · 固定验证 HEAD 最终产物（K05/K07）

## 身份

- **VALIDATION_HEAD**：62d645743ac986b9f405cdfebb055e6d171c1d9b（validation-head.txt）
- **FREEZE_BASE**：869149dcdd6f2068572354917bf23c52727cf9b6（freeze-base.txt）
- 环境：Node v22.19.0 / npm 10.9.0 系（node-version.txt / npm-version.txt 实测 10.9.3）
- 验证开始时工作树干净（status-before.txt 为空）；`unset DEST`（本轮只允许 build，未执行 push/local 游戏上传）

## 结果总表（每个 *.exit-code.txt 与 *.log 一一对应）

| 步骤 | 命令（*.command.txt） | 结果 |
| --- | --- | --- |
| production-freeze | git diff --exit-code FREEZE_BASE..HEAD -- src（排除 *.test.ts/*.spec.ts） | exit=0 零 diff |
| config-freeze | git diff --exit-code -- package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs | exit=0 零 diff |
| typecheck | npx tsc --noEmit -p tsconfig.json | exit=0 |
| typecheck-build | npx tsc --noEmit -p tsconfig.build.json | exit=0 |
| build | npm run build（dist/main.js 29.3s） | exit=0 |
| jest-key | 五件定向（IVKernel/VIKernel/IVService/VKernel/VService） | **54/54**（10.2s） |
| jest-treasury | src/runtime/treasury/ | **32 suites/571 tests 全过**（391s） |
| jest-defense | Defense 冻结 11 件 | **11 suites/118 tests 全过**（28.4s） |
| jest-full | 全仓默认收集 | **236 suites/1417 tests 全过**（631s） |
| budget | node scripts/verify-jest-budget.mjs | **PASSED 236/1417**（自带全仓重跑 647s，输出完整保存在 budget.log——其内部 results.json 临时文件已被脚本清理，摘要即该行） |
| diff-check | git diff --check | exit=0 |
| head-after | 与 VALIDATION_HEAD 比对 | 一致（模板内断言） |

- **bundle hash**：`b2999d8c2bc5ac898b1b7bcc305e4a5573a10b18424f646bbf4e7361c7017566 *dist/main.js`
  （bundle-sha256.txt。与上轮 2cee7a92 不同：Rollup 嵌入 buildTime 与 Git
  身份（任务书 §7.4/S6），两次构建 hash 本就不具字节复现性——hash 只作
  本次产物追溯，不据此推断逻辑差异；逻辑冻结以 production/config-freeze
  的 git diff 为准。）
- **四份 H18 全轨迹**：trace-key / trace-treasury / trace-full / trace-budget
  各自独立运行目录、各 1 份 H18-J06.json（~1.18MB）——证明每测试运行写
  独立目录、定向/Treasury/全仓/budget 互不覆盖。trace-key 为主归档份；
  四份结构核验一致（54 检查点/96 事件/completed=true/风险全 null diff）。

## 首次运行尾段事件与复检（如实记录）

模板尾段 `test ! -s status-after.txt` 首次运行失败（status-after.txt 含
一行 `?? openspec/.../evidence/core-candidate-seal-i/`）：**实施者在验证
脚本仍在运行期间向工作树归档了 evidence 未跟踪文件**所致——非测试/构建/
冻结检查失败（其上全部步骤 exit=0）。补救：将 evidence 目录移出后重跑
尾段三步（tail-rerun.log）：diff-check exit=0、HEAD 仍为 62d6457、
status --porcelain 为空——尾段断言在无证据归档干扰下通过；随后 evidence
移回继续归档。首次 status-after.txt 原样保留于本目录作为过程记录。

## 与其他目录的关系

- freeze/：冻结基线、差异分类与三组零 diff 核验（独立于本目录再跑一遍）
- revalidation/：reviewer subagent 第二干净 worktree 的独立复验输出
- negative-controls/：两旧变体红/还原绿与测试侧敏感性说明
