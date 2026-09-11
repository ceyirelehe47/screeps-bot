# TOOLING_VALIDATION：Windows 适配 collector-wire 优雅关闭断言

日期：2026-09-11。执行环境：Windows 10 (win32 10.0.26200)、Node v22.19.0、Git Bash。
执行者：接手 Agent（非制作方）。本记录按 AGENT-RUN.md §4“允许修正本轮外部工具的实际接口／Windows适配，但要单独提交diff、重跑相关测试并记录新的TOOLING_VALIDATION身份”办理。

## 原样首跑（修复前）

- `node --test tests/*.spec.cjs`：100 项中 99 过 1 挂，退出码 1（`initial-as-shipped-failure.tap`）。
- 唯一失败：`tests/collector-wire.spec.cjs:27` `child.kill('SIGTERM');a.equal(await end,0)`，断言 `null !== 0`。
- 根因（已用最小复现实证，非猜测）：Windows 上 `child.kill('SIGTERM')` 走 TerminateProcess 硬终止，子进程内 `process.once('SIGTERM', …)` 永不执行；父进程 close 事件为 `code=null, signal='SIGTERM'`。SIGTERM 优雅关闭路径在 Windows 属于操作系统不可达，不是工具逻辑缺陷。制作方在 Linux 验证通过属正常差异（AGENT-RUN.md §8 已声明 Windows 进程行为留待接手 Agent）。

## 修复内容（仅测试文件，未改任何 tools/）

`tests/collector-wire.spec.cjs` 第 27 行改为平台分支（完整 diff 见 `collector-wire.spec.win32-adaptation.diff`）：

- `process.platform==='win32'`：用 `C.atomicJson` 写 `guard-result.json`（`{runId, status:'ONLINE_BYTES_RESTORED'}`），由 collector 既有 1 秒轮询触发 `finish('guard_finished',0)` —— 与 SIGTERM 走**同一个 `finish()` 出口**（写 collector-footer、删锁、exit 0），等价覆盖优雅关闭路径。atomicJson 避免 collector 在 existsSync 与 readJson 之间读到半截文件。
- 其他平台：保持原 `child.kill('SIGTERM')` 逐字节不变。
- 退出等待加 10 秒 race 超时（node --test 默认无超时；且 collector 105 分钟 lifetime 退出码亦为 0，无超时保护存在假通过风险）。

同步更新 `INTEGRITY.json` 中 `tests/collector-wire.spec.cjs` 条目（bytes 4461，sha256 `a39c4a758f1fe841565bc27ee0ec201b6abc89dc093a970204ce228b0dbf796c`）。制作方 Linux 原件 `validation/final-tests.*`、`mutations.*` 未改动。

## 重跑（修复后）

- `node --test tests/*.spec.cjs`：100/100 通过，退出码 0（`rerun-after-remediation.tap`）。
- `tests/mutation-check.cjs`：5/5 变异检出，退出码 0（锚点全部位于 protocol.spec.cjs / watch-process.spec.cjs，与本修复零交集）。
- `tools/verify-package.cjs`：`PACKAGE_FILES_VERIFIED`，46 文件，退出码 0。

## 边界

- 未修改 `tools/` 任何文件；生产 collector/deadline-guard 语义不变（Linux SIGTERM 路径原样保留）。
- 生产 Windows 运行时操作员直接停止 collector 仍不可用 SIGTERM 优雅关闭；本轮生产流程不依赖该路径（collector 由 guard 终态 `guard-result.json` 驱动退出，人工中止走 `request-close.cjs`），如遇强制终止按 AGENT-RUN.md §7“强制OS终止可能没有footer”如实记述。
- 原始 zip 包（sha256 `778a3075951b970a…`）保留于 incoming/，未回写。
