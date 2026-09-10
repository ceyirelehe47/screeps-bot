# 定向本地验证记录（2026-09-11）

环境：Windows 10 / Node v22.19.0 / Git Bash；候选工作树 `screeps-bot-compat-read-i`
（分支 `compat/treasury-read-bridge-i`）。KIT=任务包解压目录，EVIDENCE=受控本地证据目录。

## 执行序列与结果

| 步骤 | 命令（要点） | 结果 |
|---|---|---|
| 包完整性 | `node $KIT/tools/verify-package.cjs` | `PACKAGE_FILES_VERIFIED`，32 文件，gameActions=0 |
| 远端核对 | `git fetch origin` + rev-list 对比 | 远端=本地=7ceabba，0/0 无前移 |
| 补丁检查 | `node $KIT/tools/apply-patch.cjs --check --repo $REPO` | `PATCH_APPLY_CHECK_PASSED`（base 7ceabba，2 文件） |
| 补丁应用 | `node $KIT/tools/apply-patch.cjs --apply --repo $REPO` | `PATCH_APPLIED_NOT_TESTED`；应用后字节=updated-files（SHA-256 复核一致） |
| 包工具测试 | `node --test $KIT/tests/package-tools.spec.cjs`（NODE_PATH 指向候选 node_modules） | 首跑 13/14：第 4 项受系统 `core.autocrlf=true` 影响；`GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null` 屏蔽后 **14/14** |
| 兼容 Node 用例 | `node --test test/treasury-compat/{bridge,real-readers,independent}.spec.cjs` | **70/70**（TAP 存证） |
| 定向 Jest | `npx --no-install jest --runInBand --runTestsByPath src/main.test.ts test/treasuryCompatRead.test.ts test/treasuryCompatIndependent.test.ts --json` | **3 suites / 8 tests 全过** |
| profile 关闭检查 | `node $KIT/tools/check-profile.cjs --repo $REPO --mode off` | `PROFILE_SOURCE_VALIDATED_ONLY`（config `ff291683faf…`） |
| 类型检查 | `tsc --noEmit -p tsconfig.build.json`；`tsc --noEmit -p tsconfig.json` | 均零错误 |
| 行尾卫生 | `git diff --check` | 干净 |
| 提交 | 两文件 test-only 提交 | `COUNTER_FIX_HEAD=6a63a2a`，推送 `7ceabba..6a63a2a` |

辅助验收（独立 subagent，只读）：
HEAD=6a63a2a 父=7ceabba、仅两文件、gitBlob 与清单一致、与 updated-files 零字节差、
重跑 70/70 与 3/8 全过、生产配置默认 OFF、treasuryCompatRead.ts 与参考字节一致
（`a9849e43…`）——**结论 ACCEPT**。

## 测试数口径

- 候选 Jest 集合不变：195 suites / 685 tests（锚点未滚动，继承 `6d514b5…` 全量）。
- 本轮定向新增运行：70 内部 Node 用例＋14 工具用例＋3/8 Jest，均不改变候选预算。
- 未运行全仓 685 与 budget 脚本（无新增条目，无生产代码变更，符合任务包第 3 节约定）。

## TAP/JSON 原件位置

受控本地 `compat-online-obs-0001-evidence/`：`package-tools.tap`（14/14 屏蔽重跑版）、
`compat-node-all.tap`（70/70）、`counter-fix-jest.json`（3/8）、`check-profile-off.json`、
各 stderr/exit 码文件。仓库只收本摘要。
