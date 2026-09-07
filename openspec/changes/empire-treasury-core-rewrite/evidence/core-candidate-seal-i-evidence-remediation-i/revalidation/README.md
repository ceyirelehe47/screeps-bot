# revalidation/ —— 第二执行上下文原始产物（Evidence Remediation I，V3/L07）

**reviewer 身份**：独立 general-purpose subagent（未参与本轮任何实施工作）——独立 reviewer 属性满足，非"同执行者第二工作树复现"。

**任务书读取记录**：读取 `…/task/task-brief.md` 全文（413 行），独立复算 SHA-256 = `6e3ff9a480e8b924eb142038f207ee5c963098aee1755444d8bb7a88c522e4a0`（与实施者归档 hash 一致）；副本与 hash 亦存于本目录（task-brief-copy.md / task-brief-sha256.txt）。

**执行环境**：独立干净 worktree（detached @ d9cd60e07f4c4e7559aec14383ee805aea0e2051，非 junction——`npm ci` 按原 lockfile 真实安装 896 包）；node v22.19.0 / npm 10.9.3；Jest 全部 `--cacheDirectory seal-ev1-review/jest-cache` 独立缓存；输出目录独立于主验证（互不覆盖）；worktree 运行前后 `git status` 干净、前后 HEAD 一致；结束即移除 worktree，不污染主仓库。

## 结果一览（每步 .command.txt/.log/.exit-code.txt；Jest 另有 --outputFile 原始 JSON）

| 步骤 | exit | 结果 |
| --- | --- | --- |
| production-freeze（vs 869149d，排除 *.test.ts/*.spec.ts） | 0 | 零差异 |
| config-freeze（六配置文件） | 0 | 零差异 |
| defense-freeze（Defense 七生产文件） | 0 | 零差异 |
| typecheck | 0 | 无错误 |
| jest-ivkernel（trace-ivkernel 导出） | 0 | 1 suite / 17 tests 全过（本轮工具敏感性与 H18 所在套件） |
| jest-key（KEY 五件 --runTestsByPath 完整路径，trace-key 导出） | 0 | 5 suites / 57 tests 全过 |
| jest-defense（十一件 --runTestsByPath，trace-defense） | 0 | 11 suites / 118 tests 全过（trace-defense 目录未被 Defense 套件消费、未创建——预期，轨迹仅 Treasury 链路导出） |
| verify-seal-trace | 0 | reviewer 自导出的 trace-key/…/H18-J06.json（1,180,356 字节，sha256 8c3bcdc7…）落盘读回后，用 `git show d9cd60e…:test/mock/treasurySealEvidence.ts` **已提交核验器**（blob fd930a4…，typescript.transpileModule 编译自 worktree node_modules）核验：completed=true/checkpoints=54/unknownIds=20/problems=0 |

详细结论见 reviewer-log.md（reviewer 自撰）。主验证与本目录为不同运行、不同目录、不同 Jest cache，分别标注。

## 旧 Seal I revalidation 的处理（§4.1 勘误）

原 `../core-candidate-seal-i/revalidation/` 仅有 README、reviewer-log 与一份轨迹（trace-key/H18-J06.json），**无对应完整原始测试输出（Jest JSON/stdout）可从仓库补回**——按任务书 §4.1 如实注明无法补回：不据此推断当时 reviewer 未运行（reviewer-log 与轨迹是真实记录，保留不动），也不按摘要重造旧 stdout/Jest JSON。本轮因测试代码已修改，无论如何都须对新固定提交重新完成第二上下文复验——即本目录产物；本目录运行不冒称发生于旧 62d6457 的原复验。
