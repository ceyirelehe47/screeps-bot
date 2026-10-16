# 项目协作约定

## 语言与执行位置

- 默认用中文沟通和编写文档。
- 构建、完整测试、性能压测和其他高负载任务在已确认适用的服务器隔离目录执行，保留日志与结果。本机只做编辑、轻量查询、传输和必要的上线控制；服务器不可用时不得改在本机执行高负载任务。

## 主分支与线上代码一致性

- 正式线上代码必须由 `main` 上已提交且工作树干净的版本构建；上线前先合并到 `main` 并同步 `origin/main`，再发布该提交的服务器构建产物。
- 每次发布前核对账号、activeWorld 分支、shard、线上实际 commit / tree / tag 和模块内容哈希，保存完整回滚模块。若线上版本比 `main` 新，先找回并整合线上已有提交，验证通过后再部署，避免覆盖已有功能。
- 本地 `main`、`origin/main` 和实际运行的发布 commit 应保持一致。发布后的证据优先保存在忽略目录；若需提交文档，应明确它与发布提交的关系，并在下次正式发布时重新对齐。
- 不从功能分支、脏工作树或来源不明的旧产物直接覆盖线上，不使用 dirty override 绕过正式发布检查。不得为了对齐而重写远端历史或丢弃他人的工作。
- 上传成功必须同时具有完整模块读回一致、目标 shard 的 console/socket 实际执行身份一致及有界运行健康检查；API accepted 不能代替执行证明。发现异常先检查当前线上身份，再按保存的完整模块回滚并重新验收。
- 凭据仅在本机内存中读取，不打印、提交或传到构建服务器。上线批准以用户在当前会话中的授权为准，已授权的同一发布不重复询问。

## 项目结构与关键规则

- Screeps TypeScript bot；`src/main.ts` 编排 tick，`src/runtime/` 负责调度、内存与任务，`src/roles/` 实现角色，`src/mount/` 提供 `.work()`，`rollup.config.js` 生成单 bundle 和源码映射。
- 不随意调整主循环阶段；保留 mounts 前的 `global.creepApi` 注册，通过原型 `.work()` 执行角色。
- 保留能量预约的释放与跨房清理；能量目标评分集中在 `src/roles/energyTargets.ts`，移动逻辑在 `src/roles/shared.ts`。
- worker 数量同时考虑建设和普通修理；紧急 rampart 由塔处理。出生调度见 `spawnPlanner.ts`，worker 任务见 `workerTaskPool.ts`。
- 内存分为 `Memory.cfg`、`Memory.runtime`、`Memory.data`、`Memory.analytics`；配置名称使用规范 ID。
- 不随意新增 console 全局导出；无集成需要不修改 `src/modules/autoplanner/` 的旧 JS 内部实现。
- 版本使用 `YYYY.MM.DD-N`。`.secret.json` 是凭据，`dist/` 是生成产物，均不提交。
- 服务器验证入口：`npm run typecheck`、`npm run test:verify -- --output-dir <隔离证据目录>`、`env -u DEST npm run build`。完整回归不得加筛选或跳过测试；按变更范围补充必要的定向验证。
