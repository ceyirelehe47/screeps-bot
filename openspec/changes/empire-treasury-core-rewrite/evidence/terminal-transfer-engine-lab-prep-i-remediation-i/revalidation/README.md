# revalidation/——第二树独立复验原始产物（任务书 §8.3）

reviewer subagent（独立执行者）在 VALIDATION_HEAD c8a6d53271b269c25c2b83c3f05cecea41433dab 的干净 detached worktree 上独立完成：

- `npm-ci.log` / `npm-ci.exit-code.txt` / `npm-ci.time.txt`：独立 `npm ci --no-audit --no-fund`（896 包、15.037s、exit 0；无 junction/symlink/共享/复制安装）。
- `independence-a/b/c/d.txt`：四项独立性核验（实体安装非符号链接 / 依赖解析路径落第二树 / 主树无污染 / lockfile 双树一致）。
- `jest-key/defense/treasury/full.json+log`：独立 Jest cache/output 复跑（KEY 9/97、Defense 11/118、Treasury 35/597、full 240/1460）。
- `budget.log` / `verify-evidence.log`：JEST_TEST_BUDGET=PASSED、TREASURY_EVIDENCE_VERIFY=PASS（4 trace 根 H18 checkpoints=54/problems=0）。
- `p01-focus-lines.txt`：独立提取的 Q01-BASELINE / Q01-FIXED 留痕行。
- `reviewer-bundle/`（manifest + single-shot.js）、`reviewer-build.log`：reviewer 自行构建的产物（sha256 49960ef8… 与主验证一致）。
- `reviewer-vm-check.cjs` / `reviewer-vm-check.log`：reviewer 自写 VM 脚本（不依赖仓库断言）——场景甲发送前标记失败 send=0、场景乙结果写失败 send=1 且 attempted 保留 stopped 未写，8/8 断言通过。
- `REVIEWER-LOG.md`：完整执行记录。
- 剔除说明：Jest cache 目录（可再生）未归档；其余原样保留。
