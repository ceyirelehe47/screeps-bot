# 主循环容错与工程问题核查

日期：2026-10-16（Asia/Shanghai）。基线：`main` 的 `b3f93276b49e2e729dd4829bad5f25fd9f783962`。修复分支：`codex/runtime-fault-isolation-20261016`。

用户确认以最新 main 为基线。本轮在独立 worktree 修改，原工作区的 `codex/runtime-cache-correctness-20261015` 分支及未提交 skill 修改保持原样。没有上传游戏代码或修改游戏 Memory。

## 已实现

- 主循环以 `runPhase` 包裹全部 42 个 phase，异常记录包含 phase 名；spawn 与 creep 分别按实体隔离。保留原执行顺序和 profiler 的计时行为，模块内部仍正常传播异常。Treasury shadow 失败后仍尝试 end，end 失败后仍执行 CPU flush；begin 未成功时不额外调用 end。
- 日志兼容 Error、字符串、空值及格式化失败的对象。映射或日志设施异常不继续向外抛出，映射结果缓存限制为 100 项。
- 更新 `Memory.analytics` 的冻结字段、导入清单和 schema 指纹，保留现有诊断结构。PowerBank 诊断原本已有 32 行上限、房间名长度限制和计数饱和保护，本轮没有迁移 Memory 数据。
- 开启 Terser 默认安全压缩的两轮处理，保留名称，未启用 unsafe 变换。
- 源码映射模块去掉 `sourcesContent`，在构建阶段预编译为排序位置索引，以差分整数、zlib 和 base64 保存，随 main 上传；每块最多 1024 个位置，运行时按需解压后通过二分查询，块缓存最多 16 项。保留未压缩 `.map` 供离线检查。构建及上传前对包含 map 的模块总字节数执行 5,000,000 字节的保守上限检查。首次实现沿用 SourceMapConsumer，在服务器测得首次映射约 908 ms，已据此改用预编译索引。修正 V8 与 source-map 的列号起点差异，同时处理 `main` 和 `main.js` 栈帧，保留其它栈帧。
- Jest 仅在转换配置中使用 TypeScript `isolatedModules`，不改变生产 tsconfig；类型检查仍单独执行。转换器通过 `tsconfig: { isolatedModules: true }` 覆盖配置，避开已弃用的 ts-jest 同名顶层选项。默认最多 2 个 worker，空闲内存阈值为 512 MB。完整验证没有使用 forceExit。
- `.opencode/` 的 3 个文件及 `CLAUDE.md` 已从此修复分支的 Git 索引移除，原文件保留在磁盘；加入大小写两种 CLAUDE 文件名忽略规则。
- `.codex/skills/screeps-game-data` 的 console 请求、限流状态请求及文档示例移除重复携带 token 的 `X-Username`。持久 auth token 通过 `X-Token` 认证的用法已核对[官方说明](https://docs.screeps.com/auth-tokens.html)，没有使用真实 token 发起网络验证。

源码图解压使用固定版本 `fflate@0.8.3` 的同步、纯 JavaScript 接口；打包只引入解压功能。[项目文档](https://github.com/101arrowz/fflate)说明该接口可与 zlib 数据互通。

## 核查后保留的事项

| 清单项 | 当前证据与后续边界 |
| --- | --- |
| 26 条循环依赖 | 基线构建确认。主要经过 Treasury、resourceControl、synthesisControl 与 runtimeServices。需要拆分服务装配与业务查询依赖，并验证模块初始化及 Treasury 生命周期；本轮未修改依赖图。 |
| strict | 生产配置加 `--strict` 实测仍有 238 个诊断，其中 hubPlanner 50 个、synthesisControl 21 个、carrier 14 个。当前 tsconfig 未开启 strict；这些问题仍需逐模块修复。 |
| 房间与 shard 字面量 | 排除测试和声明文件后，文本核查得到 14 个含房间字面量的源文件、30 个 shard 数字字面量。其中包含 Treasury 固定 lane、灰度身份校验以及坐标占位值，不能统一替换成 Memory 配置。 |
| 超大文件 | marketSaleAutomation 12,227 行、marketBaseResourceAutomation 10,103 行、resourceControl 8,927 行。拆分时应按读模型、计划、执行、持久化分层，结合循环依赖一起处理。 |
| teardown 泄漏 | 内存配置降低测试成本，但不等于消除了未关闭句柄。本次完整运行自然以 0 退出，日志未出现 OOM、SIGKILL 或 worker 未退出警告；这不证明所有生命周期泄漏都已消除，没有通过 forceExit 掩盖问题。 |

异常隔离不提供模块级事务回滚，也不能捕获 Screeps 引擎强制终止的 CPU 超限或模块加载前错误。上线仍需核对线上代码身份，并观察首个错误的映射开销及实际运行情况。

## 验证位置

所有构建、类型检查、Jest 与性能检查均在已核对身份和资源余量的 `dsh` 服务器独立目录执行：

```text
/root/codex-jobs/20261016-runtime-fault-isolation
```

服务器为 `VM-0-7-ubuntu`，Node.js `22.22.1`、npm `9.2.0`。服务器以归档源码建立独立临时 Git 仓库，临时 HEAD 为归档基线的验证提交；其嵌入 build commit 不是可发布身份。修改内容另以文件 SHA256 与本机逐项比对。没有复制 `.secret.json`；构建清除 `DEST`。本机只做编辑、轻量查询与文件传输。

基线复现：新增主循环故障用例配合旧源码，3 个用例全部失败；原诊断声明测试 6 个用例中 1 个失败。

修复版最终聚焦验证：双配置类型检查通过；6 个套件 / 81 个用例通过。完整测试、产物字节数与最终源码校验结果见同目录机器可读证据。

分块版构建初验：main 为 3,420,482 字节，映射模块为 1,140,348 字节，总计 4,560,830 字节。索引包含 363,634 个位置、356 个块；实际产物的 64 个抽样位置与标准映射器一致。服务器收尾测量首次映射约 4.2 ms、缓存命中约 0.0085 ms；这是主机测量，不是 Screeps 游戏 CPU 或线上验收。


## 最终验收

| 检查 | 结果 |
| --- | --- |
| 双配置类型检查 | 通过 |
| 聚焦回归 | 6 套件 / 81 用例通过 |
| 无过滤完整回归 | 260 套件 / 1974 用例通过，0 失败、0 pending、0 todo |
| 测试完整性守卫 | JEST_TEST_INTEGRITY=PASSED；跟踪文件、磁盘文件和 Jest 发现清单一致，运行前后源码身份一致 |
| 完整运行退出 | 0；约 529 秒，未使用 forceExit，未见 OOM / worker 未退出警告 |
| 构建与实际映射 | 通过；主代码与 map 共 4,560,830 字节，64 个抽样位置与标准映射器一致 |
| 本机与服务器源码 | 15 个修改/新增文件的 SHA256 全部一致 |
| Git 忽略与文件保留 | CLAUDE.md 与 .opencode 的 3 个文件已移出此分支索引，磁盘文件保留 |
| strict 专项审计 | 238 个生产代码诊断，尚待修复；不属于默认类型检查通过的范围 |

[机器可读汇总](2026-10-16-runtime-fault-isolation/validation-summary.json)包含全部命令、退出码、产物 SHA256、严格模式分布和源码哈希。

原始证据保留在本 worktree 的 `monitor-data/20261016-runtime-fault-isolation/`：完整 Jest 结果与日志、发现清单、执行身份、聚焦/红灯结果、strict 日志和产物检查日志。该目录按现有规则忽略，未加入 Git；服务器原始目录同样保留。归档 `final-evidence.tar.gz` 的 SHA256 为 `1a2dcddaedf0925f326cb4496c68c06246e68975a6690575eaabc14f54287d29`。

远端 origin/main 在收尾核对时仍为 `b3f93276b49e2e729dd4829bad5f25fd9f783962`。本轮未提交、未合并、未部署；构建产物属于隔离验证工作树，不是生产发布身份。
