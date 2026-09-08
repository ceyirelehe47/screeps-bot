# revalidation——第二树复验（§7.3）产物归档

- 运行脚本：`run-tree2.sh`（同一 VALIDATION_HEAD `324f21a` 建 detached worktree、独立 `npm ci --no-audit --no-fund`；副本归档）。
- `wrapper-first-run.log`／`wrapper-second-run.log`：首跑在最后一步"三产物身份核对"因 node 相对路径以 worktree 为 cwd 解析报 ENOENT 静默失败（`tree2-exit=1`，无 TREE2_COMPLETE；失败点之前 npm ci、LAB、Slice 0、三构建均已成功且 hash 正确）；修正为经环境变量传绝对路径后完整重跑成功（`tree2-exit=0`、`TREE2_COMPLETE`）。两份日志如实归档，无隐藏重试。
- 复验范围（任务书 §7.3）：LAB（probe 22＋runI 12——含两项 observer 故障（require 抛错／导出不合法）的实际产物行为与 single-shot 缺失时的观察对照 it）与 Slice 0 三件；不重复全仓压力／budget 长跑。无独立 reviewer，如实标同一执行者第二树复现。

## 步骤退出码（全部 0）

`npm-ci`、`jest-lab`、`jest-slice`、`lab-observer`、`lab-single-shot`、`lab-main`（`*.exit-code.txt` 逐条可核）。

## 关键事实

- jest-lab 2/34、jest-slice 3/23（failed 全 0）。
- 独立依赖证明：`jest-resolve.txt`/`typescript-resolve.txt` 落第二树 `…\tree\node_modules\…`；`lockfile-sha.txt`＝`490ee9c70876f8ab72de2dd497331b9e177f63fe41565a837244401dad9c686a`（与主树 lockfile 一致，本轮未改依赖）。
- 三产物身份（`lab-artifacts-identity.txt`）：observer 9160/`96721926…`、single-shot 27697/`7730421d…`、main 7721/`0a71f720…`——与主树主验证构建逐 hash 一致。
- `worktree-remove.log`：验证后 worktree 已清理（主树 `git worktree list` 仅主树一行）。
