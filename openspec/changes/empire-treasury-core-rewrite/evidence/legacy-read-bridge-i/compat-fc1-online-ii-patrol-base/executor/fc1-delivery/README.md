# FC1 入口与 emitter 闭环修订 r2

本维护包从已提交的 `0cdbd061c2645366bd409dbdbd262881d277cb35` 源码组装最终执行器，保留 `11b818fb` 的 10/25 time admission 修复。新外部授权 `treasury-full-cost-FC1-online-II-2026-09-24` 与冻结源码的 emitter `treasury-full-cost-FC1-online-I-2026-09-24` 分开核验；执行器通过源码 Git 对象和 emitter literal 校验，再带入固定 TypeScript 5.9.3 编译的 runtime、preview、Core 与 CPU helper 工件。

## 离线组装与回归

在 G1 修复 worktree 根目录运行：

```sh
node openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-fc1-entry-closure-r2/build-offline-executor.cjs \
  --repo /path/to/screeps-worktree \
  --source-ref 0cdbd061c2645366bd409dbdbd262881d277cb35 \
  --typescript /path/to/node_modules/typescript \
  --out /path/outside/repository/fc1-entry-closure-r2/executor
node /path/outside/repository/fc1-entry-closure-r2/executor/tools/run-tests.cjs \
  --out /path/outside/repository/fc1-entry-closure-r2/tests
node --test /path/outside/repository/fc1-entry-closure-r2/executor/tests/entry-closure.integration.spec.cjs
```

`--typescript` 必须解析到 5.9.3。生成包的 `runtime-source-manifest.json` 记录源 blob、发射 JS 摘要及 emitter。`tools/run-tests.cjs` 只接受 contract 列出的组和确实执行的测试数；结果同时绑定最终 `INTEGRITY.json` 指纹。集成用例用真实 run-tests 结果跑最终 observe 代码，合成授权和 Git 前置，第一处工作目录写入即由 barrier 截止；失败结果在该处之前拒绝。

## 验证范围与在线状态

- Maker：131/131；最终执行器：145/145（100 项遗留风险回归、45 项 FC1 组合）。
- 最终组合包括从冻结 runtime/preview/Core 构建的 4 个真实日志点，经最终 collector 接受 4 份主报告和 4 份成本回执；另由 lifecycle fixture 覆盖单次 candidate/restore 及精确关闭。
- Entry closure：2/2，覆盖 authentic producer 通过至受控 barrier、缺组、零执行、失败、旧指纹和汇总不一致的拒绝。
- 本轮未取得当前对话中的 FC1 实机启动授权。policy 仍为 `WAITING_FOR_EXPLICIT_AUTHORIZATION`，null 新授权/运行字段，`onlineExecutionReady=false`。没有访问 Screeps API、部署、marker、candidate POST、restore POST 或业务样本。
- 这些离线模拟不代表线上 CPU 结果、部署、实机恢复或本轮成本结论。历史 `TIMING_PROFILE_INVALID` 与 R1 恢复记录保持原样。
