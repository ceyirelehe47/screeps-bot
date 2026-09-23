# R1 v2 修复说明

## 原问题

Agent 回报：原 R1 的 467 项仓库 Node 测试中，465 pass、2 fail。
制作端核对了两份远端历史测试及原交付 ZIP，确认 R1 v1 漏做了两处历史断言边界适配。
原始 Windows 日志没有提供给制作端，因此 Agent 的具体本地 HEAD、STOP 和零写入事实属于回报，修复器在执行机再次核验。

## 两处固定源码修复

`test/treasury-compat/attribution.spec.cjs` 保留 IX 变换逆向、14 条规则与当前 generator 输出校验；70443 字节断言改为对当前 Core 经 R1 精确逆变换后的 XV 层执行。同时对当前 R1 Core 增加独立固定 SHA-256 校验。不是将 70443 草率替换为 74835。

`test/treasury-compat/hotpath-optimization.spec.cjs` 保留 37 次历史 Map-get 差断言，让其比较历史 before 与 R1 逆变换后的 XV。额外保留实际 R1 与该历史层的业务语义比较。不是将 37 替换为 148。

两份补丁均固定完整 before Git blob，精确锚点计数并验证逆向恢复。两份测试名、测试数量和原有业务断言没有删除或跳过。

## 不改运行时

R1 generated Core 仍为 74835 bytes，Git blob `5d3433d1d756ea6912bef4933bea2b5b189a819f`，SHA-256 `4d95104a44554f40065f65501c506f176653f3cb44c4fba0bcd0409cd5830f08`。
原 R1 变换、集成补丁、Core fixtures、43 项 Core 测试与 milestone 判定保持 v1 字节。
配置、CPU 探针、preview、main、依赖锁、生成器源码与输出均不因这次修复改变。

## 向前接续

旧 R1 提交身份不依赖回报中的短 SHA。修复器读取原 `source-preparation.json` 与 `prepared.json`，验证完整 parent、message、tree、9 路径、全部 before/after 字节，以及从固定 XV Git blob 和 v1 源码 payload 独立重建出的实现文件。随后在已经认证的 generator 上执行 --check，复核生成的两份元数据与 Core。

只能在该 R1 提交上增加一个两文件测试修复提交；若精确的修复提交已经存在，验证后复用，绝不再次制造同一提交。总源码差集是原 9 路径加 2 个历史测试，共 11 条。

继承执行器的 implementationBase 绑定原 R1 提交，implementationHead/compatBase 绑定新的测试修复提交，source-manifest 只描述该直接父子之间的两文件变化；外层保存完整 R1 来源与旧 STOP。这样没有伪造“修复提交直接从 XV 出生”的历史。

仍从固定 0e2b71ad 归档提取 66 个 payload。继承的 runtime/tool/test/vendor 文件字节一律不改，只重绑 policy 与 source manifest，另附本包和准备证据。继承的历史状态标签仍只作为执行协议标签，不代表当前业务版本是 XV。

## 授权不刷新

authorizationId 与 runId 与 v1 完全相同。必须证实旧目录没有 live/、没有发布结果，旧 STOP 恰为两项指定失败，旧包及解析执行器指纹仍匹配；Git common-dir 中该 R1 授权 marker 必须不存在。任何已消耗记录都阻止执行，不删除也不重新命名。Screeps 写入仍由继承执行器独占处理，最多一次 candidate、一次 restore，不自动重发。

## 制作端验证边界

包测试包括真实 XV/R1 完整 Core 的语义差分，以及两项断言修复、接续状态机、原生 Git 前向提交、脏工作树/伪造回执/范围漂移/模式变化拒绝和额度保护。
历史测试路由和源码 recipe 的部分用例使用明确的合成 Git fixture，并非真实仓库整体集成。
制作环境无法取得完整仓库及锁定依赖，因此没有宣称 467 仓库测试、165 继承工具测试、双 tsc、完整回放、Jest 或 Rollup 在制作端通过。
真实环境必须完整重跑，不能复用旧 STOP 前的部分结果；任何新失败停止而不现场修绿。
