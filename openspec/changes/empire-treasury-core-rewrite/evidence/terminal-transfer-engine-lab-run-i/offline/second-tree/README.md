# offline/second-tree/——第二干净工作树复验（Lab Run I 接线）

在 VALIDATION_HEAD `15b027bc3f002b97219001a8766fd6d6e0e78736` 的 detached
worktree 上独立 `npm ci`（不共享/不链接主树 node_modules）后复跑离线接线
测试（任务书 §7.1：复跑 LAB 与 Slice 0 即可）。执行脚本 `run-tree2.sh`
（副本同目录），wrapper 输出 `wrapper2.log`。

## 结果（6 步全部 exit 0）

| 步骤 | 结果 |
| --- | --- |
| npm ci（独立安装） | exit 0；lockfile 双树 sha256 一致（490ee9c7…，见 lockfile-sha.txt） |
| jest-lab（probe.test.ts + runI.test.ts） | 29/29 全绿（runI=7、probe=22） |
| jest-slice0（Slice 0 三件） | 23/23 全绿 |
| 三次 lab 构建 | 与主树产物字节一致：observer 9160B/96721926…、single-shot 27697B/7730421d…、run-i-main main.js 7430B/44f624cc…（全部 PREPARED_NOT_RUN） |

解析路径（resolve-jest.txt）：jest/typescript 均解析到第二树 worktree 自己
的 node_modules——独立安装成立。worktree 已移除（git worktree list 仅主树）。

## 说明

首次运行（wrapper.log，未归档）因脚本缺陷提前终止：`npm ci` 之前执行
`require.resolve("jest")` 在无 node_modules 的 worktree 必然失败触发 set -e
退出，且外层 `echo "tree2-exit=$?"` 掩盖了非零码。已修复脚本（移除 ci 前的
resolve 记录）并完整重跑（wrapper2.log）；失败运行未产生任何仓库写入，其
临时产物目录已删除。此为脚本工程问题，不涉及被测对象。
