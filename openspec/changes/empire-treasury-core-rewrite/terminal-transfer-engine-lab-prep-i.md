# Terminal Transfer Engine Lab Prep I——实验交接说明（PREPARED_NOT_RUN）

任务身份：**Terminal Transfer Engine Lab Prep I**（验收索引 P01–P06；任务书编制 2026-09-08）。
本文是隔离实验包的可执行交接说明：探针代码与离线自测已完成，**真实引擎运行一律未执行**（PREPARED_NOT_RUN）。
旧版接线计划见 `terminal-transfer-slice-0.md` §3——其中的归属/费用/单条在途接线细节以 Remediation I/II 的当前实现为准，本文不批量重写历史报告。
**Lab Prep I · Remediation I（Q01–Q06）更新**：single-shot 发送前置已收紧为"attempted 标记写入并读回确认后才进入 send 边界"（详见 §4 与 `probe.test.ts` 新增失败路径矩阵）；固定旧产物上的基线复现与修复对照见 `evidence/terminal-transfer-engine-lab-prep-i-remediation-i/`。

## 1. 交付物组成

| 组件 | 位置 | 语义 |
| --- | --- | --- |
| 探针源码 | `test/lab/terminal-transfer/`（labConfig/worldRead/sample/observer/controlRecord/sendGate/singleShot） | 真实 API 薄包装；不导入生产模块、不进生产 bundle |
| observer 入口 | `test/lab/terminal-transfer/observer.ts` | 默认只读：采样世界/费用/交易视图，零发送、零 Memory 写；模块及其依赖不含 terminal.send 调用 |
| single-shot 入口 | `test/lab/terminal-transfer/singleShot.ts` | 仅供未来单独授权的隔离实验：默认未武装，完整实验配置 + 一次性控制记录同时匹配且 `Game.time === targetTick`，**且 attempted 标记写入控制槽并重新读回确认匹配**，才尝试一次 100H 发送；标记未确认（序列化失败/超限/赋值异常/静默丢写/读回异常或不匹配）零发送；send 之后任何失败不重试、不回滚已确认标记 |
| 实验控制记录 | `Memory.__labTerminalTransferProbe`（独立键，非生产 Memory 根） | 单 run、≤4KiB（JSON 字符数口径）、缺失/损坏/含未知字段不自动初始化；正常完成标记 stopped 不自动再武装；有界保留至世界销毁或只读人工重置（无 TTL 重获发送资格） |
| 构建入口 | `scripts/build-treasury-terminal-lab.mjs` | 默认 observer，`--mode single-shot` 生成未武装调用版；仅本地 TypeScript transpile + Rollup 内联配置（不加载根 rollup 配置/部署插件、无网络、无上传）；输出独立目录 + manifest.json（PREPARED_NOT_RUN） |
| 离线自测 | `test/lab/terminal-transfer/probe.test.ts`（17 it） | 自行构建到独立临时目录并 require 真实产物执行（门禁矩阵/恰一次/不重试/OK 不自造效果/JSON 重载/读异常/镜像保留 + Remediation I：旧产物 VM 基线复现 7 场景、新产物 0/0/0 对照、send 入口内标记可见、读回故障变体、结果更新失败不回退、写入函数单元拒绝） |

构建命令（仓库内或从仓库外含空格路径均可）：

```bash
node scripts/build-treasury-terminal-lab.mjs --out <独立目录>            # observer（默认）
node scripts/build-treasury-terminal-lab.mjs --mode single-shot --out <独立目录>
```

## 2. 版本前置条件

固定参考基准（**读取过的源码 SHA，不是已实跑的安装组合，也不代表正式服版本**）：

- engine：`80977824199a596d174d392fd0cf8c458c21fcbd`
- driver：`cf63d8adf902663e2ebddd7f8c5b7baa425dc928`

未来授权实验前须确认实际安装的 engine/driver/运行时/世界尺寸与依赖版本：以实验世界控制台/驱动配置实际报告的版本为准逐一记录进实验日志；**未确认的兼容性标"待实测"**，不换成 `latest`，也不要求本轮安装任何游戏服务。官方文档事实（交易视图每方向有限历史、`send()` OK 表示已调度、游戏循环把脚本指令与随后世界更新分开）只是采样与调用契约的设计依据，不是本轮实验结果。

## 3. 原始 API 与国库边界

探针是**引擎契约的原始 API 对照工具**，不是另一套国库，也没有把国库接到真实引擎：

- 不复制国库的授权、重试、清理、对账权威或 retired/range 机制；采样不给出 `observed_committed`／`observed_not_executed` 之类的结论；
- 读取缺口如实报告：缺房间/缺结构/读失败不填"库存 0、交易空且读取成功"；同 ID 镜像与不同 ID 记录原样保留，不删改与预期不一致的数据；
- 费用报价运行时经 `Game.market.calcTransactionCost` 读取——不使用 fake 世界的尺寸 128 或硬编码费用 26；注意 @types 注释公式与 fake 原型公式不同，真实公式以实测为准；
- 实验控制记录的 Memory read-back 只是普通运行与控制事实确实保留的 reset 下的防重入/防重试约束，**不是** CPU/driver 任意故障下的 exactly-once。

## 4. 后续实验操作顺序（须单独授权）

### 4.1 配置如何进入产物（编译时交接；Remediation I §6 澄清）

**当前唯一配置来源是编译时常量** `test/lab/terminal-transfer/labConfig.ts` 的 `LAB_EXAMPLE_EXPERIMENT`（合成值）；singleShot 模块据此派生调用版模式。`example.experiment.json` 是随 observer 产物分发的**文档示例**（构建器只复制、运行时不读取）；Memory 控制记录只携带实验 ID 与武装/尝试/停止事实，**不覆盖**编译进产物的路线、用户、结构、预算和 targetTick。本轮不新增 `--config`、热加载、运行时配置 store 或上传器，也不引入真实实验身份。

更换实验配置 = 源码变化，固定流程：

1. 本轮保留合成默认配置，两个产物都不上传。未来取得单独实验授权后，先在一次性世界**只读**确认期望身份与时点（observer），不能自动读取正式配置补齐。
2. 将经确认的配置写入 `labConfig.ts` 并同步 `example.experiment.json`。**修改 JSON 或 Memory 附加字段不会改变已构建产物**；不允许只修改已构建 JS 而继续沿用原 hash 与验证声明。
3. 配置属于源码变化：重新固定源码提交、重建两个入口、验证生成物与配置对应，记录源码 SHA 和产物 hash（manifest 已含 repoSourceCommit/output sha256/lockfileSha256，无需新清单协议）；只读版产物仍无 writer 分支。
4. 只有未来单独获准的实例操作才包含上传、控制记录武装及实际调用；切换只读/撤销武装和保存外部证据的步骤继续保留。错过 targetTick 不自动续期或改为下一 tick。

### 4.2 操作顺序

1. 建立一次性新世界与合成用户（同一隔离 shard、无 Power、无其他 writer）；原型房间名 `W1N57`/`W10N57` 是实验固定场景，不是正式服业务配置。
2. 安装两个 Terminal，放置资源（真实 F0 与费用从环境读取，不照抄 fake 的 100000 空位/26 能源）。
3. 先载入 **observer** 核对环境（两端读数/报价/视图可见性正常）。
4. 明确选择一个实验，写入实验控制记录武装 **single-shot**（显式实验 ID、完整关联描述、目标 tick、期望用户/shard/两端结构身份、允许最大费用——示例见 `example.experiment.json`，全部合成值，默认不可发送、不自动读取正式配置补齐）。产物在发送前会自行完成"标记写入→读回确认"；武装方只需提供合法小记录（含未知字段或超限的记录会被读取拒绝）。
5. 观测窗口固定且有限（默认 32 个采样）；完整样本输出到外部日志，不累计进游戏 Memory；超过可采集容量即标记截断并停止采集——**截断不是无交易**。
6. 停止步骤：先撤销武装并保留 observer，收集原始产物，再销毁一次性世界；不得把资源反向转回作为自动清理。

## 5. 待测矩阵

| 后续实验 | 需要得到的事实 | 本轮状态 |
| --- | --- | --- |
| 正常 100H | 同步返回；调用 tick 与后续 tick 库存/费用/cooldown/两视图记录；同交易 ID 镜像 | 探针代码+离线自测完成；真实运行未执行 |
| 即时拒绝/处理层无结果 | 区分探针前置拒绝、API 非 OK、API 已 OK 但后续无记录；不得以无记录证明未执行 | 记录方式具备；真实 fixture 与触发方法列计划 |
| 目标仅容纳 60H | 是否实际缩量、实际 amount 及按实际量产生的费用 | 裸 API 对照计划；不声称国库在已知容量不足时会接纳 100H |
| 普通 global reset | heap 变化、实际保留下来的 Memory、库存、cooldown 和交易可见性 | 离线接口覆盖（JSON 重载/模块重建）；真实 reset 待授权执行 |
| CPU 终止/Memory-intent 保存不一致 | 真实 driver 层的 Memory 和 intent 独立留存组合、外部世界效果 | 只列切点与需取得的原始证据；本轮不写/执行超限或进程杀死注入器 |

CPU 超限不得以普通 throw、Node 强制异常、手动旧 Memory 覆盖冒充；外部世界状态由真实引擎负责，复验一处中断时不能把世界和 Memory 独立拼成自己期望的答案。

## 6. 环境隔离与停止边界

- 环境隔离由**外部运行流程**保证：`Game.shard.name`、用户名、实验 ID 都不能证明目标不是正式环境——这也是本轮完全不提供自动上传/连接入口的原因。
- 本轮运行命令只包含本地构建与离线测试；服务器创建、脚本上传与发送步骤统一标"单独授权后执行"，不从测试自动触发。若公开源码不足以给出可靠启动命令，则列出明确环境前置条件，不编造"已验证一键启动"。
- **本轮准备项完成即停止**：不自行从 PREPARED 升级为真实运行、不上传任一产物、不发起真实调拨、不为探针"足够通用"新增其他路线/自动补货/市场/自动 rearm/部分量结算/永久审计/分布式编排。
