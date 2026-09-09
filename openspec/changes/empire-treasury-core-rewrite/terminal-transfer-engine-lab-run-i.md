# Terminal Transfer Engine Lab Run I——真实引擎实验说明

状态：**AUTHORIZATION_REQUIRED**（离线接线已完成；真实引擎仍 NOT_RUN）。

编制日期：2026-09-08。任务书：`treasury-terminal-transfer-engine-lab-run-I-execution.md`
（归档于 `evidence/terminal-transfer-engine-lab-run-i/task/task-brief.md`）。验收索引 S01–S06。

## 1. 本轮目标与授权门禁

唯一新增事实目标：由真实 Screeps runner 执行现有 single-shot，经真实
driver／processor 处理一次 W1N57 → W10N57 的 100H 请求，并从后续游戏观察
核对结果。

授权边界（任务书 §0）：启动本地一次性实验环境、创建合成 bot 与两个
Terminal、装载实验探针、最多一次发送 100H——这些动作**须用户明确授权后**
才执行。未授权状态只允许源码读取、文档与离线接线；本文所述产物均为
PREPARED_NOT_RUN，未上传、未装载、未武装。

## 2. 离线接线交付（本轮已完成）

实验模块三件套（各自独立构建、字节独立，装载时保持 observer／single-shot
原始产物字节）：

| 模块 | 入口源码 | 构建命令 | 职责 |
| --- | --- | --- | --- |
| `observer` | `test/lab/terminal-transfer/observer.ts` | `node scripts/build-treasury-terminal-lab.mjs --out <dir>` | 只读零写采样（既有产物，未改动） |
| `single-shot` | `test/lab/terminal-transfer/singleShot.ts` | 同上 `--mode single-shot` | 未武装调用版（既有产物，未改动；发送前标记确认与门禁不变） |
| `main`（新） | `test/lab/terminal-transfer/runIMain.ts` | 同上 `--mode run-i-main`（输出 `main.js`） | 薄装配入口 |

`runIMain.ts` 边界（任务书 §4.4）：

- 观察窗口 `targetTick−2 .. targetTick+20`（共 23 tick，低于 maxSamples=32）；
  窗口内每 tick **先** observer **后**（仅 `Game.time === targetTick`）
  single-shot，保留调用 tick 前态；窗口外零调用、错过目标 tick 不补调不续期。
- 模块加载零动作；经 Screeps 运行时模块系统 `require("observer")` /
  `require("single-shot")` 装配。**发送依赖观察装配（Wiring Remediation I
  单向依赖）**：observer 模块缺失、未导出 loop 或 `observer.loop()` 向外
  抛错时，如实记录错误事实（复用 `lab-run-i-module-error`／外层
  `lab-run-i-main-error`）并立即结束本次 `main.loop`——本次不解析、不调用
  single-shot、零 send、控制槽零触碰；反方向不成立：single-shot 不可用时
  已完成的只读观察与后续窗口采样仍继续。正常返回 `undefined` 是合法 void
  语义，不升级为数据健康证明（真实实验仍须外部流程先取得只读基线并在
  观察失败时停止）。
- 不直接调用 `terminal.send`、不初始化／重置／复制控制槽、不复制
  attempted／费用／归属判断——发送资格完全由既有 single-shot 决定。
- 窗口首个 tick 输出一行装配／窗口信息（外部日志 console，不写游戏
  Memory）；窗口标志为模块 heap，global reset 会重置（实验已知边界）。

离线接线自测：`test/lab/terminal-transfer/runI.test.ts`（12 用例）——三产物
真实构建后按 Screeps 模块系统在 VM 装配，覆盖：装载零动作、窗口外零调用、
非目标 tick 只采样、目标 tick 先 observer 后 single-shot 恰一次、完整窗口
send=1、无武装 send=0、错过目标 tick 不补调；Wiring Remediation I 故障
矩阵（main 沙箱 require／调用边界注入，不修改 Memory 不取消武装）——
observer require 抛错／导出不合法（`{}` 缺 loop、`{loop:1}` 非函数、null
补充）时 single-shot 零解析零调用零 send 且控制槽内容与引用不变、目标
tick 重复调用与 T+1 均无发送、T+1 恢复真实 observer 继续观察不补发；
`observer.loop()` 向外抛错沿既有 dispatch 错误出口阻断发送；single-shot
缺失／导出不合法时真实 observer 在目标 tick 及后续窗口继续采样（反方向
对照）；同 T 重复调用目标 tick 不增发。并断言构建器加入第三模式后
observer／single-shot 产物与 Remediation II 归档**逐字节一致**（main 按
本轮实际构建身份核验）。

`labConfig.ts` 仍为唯一编译配置来源。**Execution 轮（2026-09-09）已回填
真实实验身份**（见下节），合成示例值作为旧配置 fixture（LEGACY_EXPERIMENT）
保留于 probe.test，历史归档产物字节不再与当前产物相等（§4.3 合法迁移）。

## 2a. Execution 轮交付（2026-09-09，已授权执行）

用户授权来源：会话明确回复「我给予你离线授权, 不接入线上服务器即可」
（范围＝任务书 §0：本机一次性隔离环境、最多一次发送 100H、证据保存后
停止清理、不接入线上/正式服/PTR/真实账号）。实机结论见主报告与本文件
`evidence/terminal-transfer-engine-lab-run-i/engine-run/`。

真实实验身份（labConfig 当前编译值，来源＝隔离世界实测读回）：

| 项 | 值 |
| --- | --- |
| experimentId | `lab-run1-exec-0001`（描述 `lab-run1-exec-0001 W1N57 to W10N57 100H`） |
| shardName | `standalone-no-shard`（无 shard 引擎约定值，见修复提案） |
| username / 房间 | `lab-synthetic-user`；W1N57 → W10N57（同一合成 bot 拥有） |
| 结构 ID | 源 `b0254105a49b92c`、目标 `c61a4141a4a9fcb`（初始化读回） |
| targetTick | 557（暂停时刻 T0=554+3；窗口 555..577） |
| maxFeeEnergy | 10（基线实测报价：引擎环绕距离公式 `ceil(100×(1−e^(−3/30)))`） |
| 费用口径 | 报价与 send 扣费同走 `calcTerminalEnergyCost(calcRoomsDistance(continuous))`，runner/processor 共用同一实现与启动时 worldSize |

真实配置下的三产物身份（`PREPARED_NOT_RUN`，装载前记录）：
observer 10193 字节／SHA-256 `04fac1c2e76c0efe95dbc30f5591b2031a299368cfe793a6c3ca8119b7d5d8c2`；
single-shot 29139 字节／`3266d7b280688bcbc2156adcf1b3876ca5034c52344f2bd0aa3cb1e8373988e3`；
main 8754 字节／`3e944685b0023b0a41d7dfb6fe80fedd2d08cfe96ef4f940a38ebc12f23cdbdc`。

**sendGate 无 shard 引擎兼容修复（单列提案）**：standalone runtime 的
`Game` 不暴露 `shard`，原 `Game.shard.name` 直接读取使门禁在该引擎上
永远 `world_read_error` 拒绝。修复引入 `LAB_STANDALONE_NO_SHARD_NAME`
约定值：仅当配置**显式声明**该值且引擎读不出 shard 时通过；任何声明与
读数不符仍拒绝（强度不降）。详见
`terminal-transfer-lab-run1-shard-gate-compatibility.md` 与
`evidence/terminal-transfer-engine-lab-run-i/engine-run/api-incompatibility-game-shard.md`。

**执行结果（窗口结束后记录，含实证纠正）**：状态
**ENGINE_LAB_INCONCLUSIVE**。窗口 555..577 完整执行、observer 采样
23/23 tick、T=557 single-shot 在发送边界之前被门禁前置拒绝
（`shard_mismatch`）——单次 send 调用未消费、零交易、零资源变化、
控制记录保持 armed/attempted=false（撤装后 armed=false）。执行后只读
探查实证**推翻了修复提案的事实基础**：真实 runtime 的
`Game.shard={name:"Forst",type:"normal",ptr:false}` 存在（静态源码
搜索未覆盖其注入路径）；正确回填值应为 `"Forst"`。同时实测
worldSize 随房间生成漂移（11→58/59）→ 报价 q 从 10 变 26——编译期
固定 maxFeeEnergy 的设计与该引擎的报价漂移不兼容（即使 shard 校验
通过也会 `fee_over_budget` 拒绝）。按任务书 §4.5 不改 T/不重试；完整
事实链与判读见
`evidence/terminal-transfer-engine-lab-run-i/terminal-transfer-engine-lab-run-i-execution-local-validation.md`。
未来重开须新任务书（携带本轮两条实证）。

离线自测相应变化：probe.test 23 用例（新增修复专项用例：无 shard 引擎
通过分支 + 旧产物修复前 `world_read_error` 行为对照；旧产物反例世界切换
为 LEGACY_EXPERIMENT 旧配置 fixture——§4.3 不混用两个身份）；runI.test
12 用例（三 manifest 自洽、内嵌同一配置、归档历史身份完整、当前产物
不再等于归档字节）。

## 3. 授权后动作顺序（概要；命令参数以实际安装版本核对为准）

1. 独立实验目录安装固定版本官方 standalone server（`screeps@4.3.0` 组合，
   精确版本与来源按任务书 §3.1 核对归档）；监听仅本机。
2. 管理入口暂停模拟并确认静止；创建两个房间与一个合成 NPC bot；布置合法
   控制器与 Terminal 及 §2 初始库存；回读结构 ID 并归档初始化快照。
3. 真实 runner 连续执行 observer 取得只读基线（≥2 个不同 tick）；装配
   外部日志收集通道并证明可用。
4. 暂停固定 `T0`，读回真实身份填入 `labConfig.ts` → 提交 → 固定
   VALIDATION_HEAD → 重建三产物并记录 hash → 装载回读核对模块字节。
5. 写入合法小控制记录（armed=true、attempted=false、完整 JSON ≤4096
   UTF-8 字节）并回读确认；恢复模拟，让 main×observer×single-shot 在真实
   runner 中执行一次发送与 T+20 窗口观察。
6. 按实际基线判读（H/energy/空位/cooldown/交易镜像）；窗口结束立即暂停、
   切只读、撤销武装；停止完整进程组并只清理本次新建环境。

判读与状态语义（ENGINE_LAB_PASS／INCONCLUSIVE／MISMATCH／ENV_BLOCKED）
及停止边界见任务书 §5/§6/§7。

## 4. 证据

`evidence/terminal-transfer-engine-lab-run-i/`：`task/`（任务书归档）、
`offline/`（离线验证与第二树复跑）、主报告（含授权状态声明）。
`environment/`、`engine-run/` 目录在真实实验授权后才会有内容。
