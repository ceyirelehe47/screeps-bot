# Terminal Transfer Engine Lab Run I——真实引擎实验说明

**Treasury Terminal Integration I（2026-09-10，离线交付全成、实机 LIVE_FAIL
——环境时序事故，零 send 调用，非被测代码缺陷）**：ChatGPT 实现包（基线
7314277，patch sha 1a05f5a1…）原样应用 17 文件（IMPL_HEAD 92e0e50：真实
adapter/coordinator/assembly 接生产 facade/kernel、默认关闭入口、隔离构建器、
停止工具修复）→ Agent 独立验收（反例 7 用例 e2966f3；Windows smoke 首轮
失败→定位 Get-CimInstance 固有 ~1.6s/次、4500ms 结构性不可达→修复 tree 单
查询+内核探活快路径 3db0770，10/10 PASS）→ 预算 246/1515（1a6c7a2）→ 新
一次性世界 lab-ti1-0001（用户 lab-ti-user-0001、双 Terminal ti10001aa57
00001/2、q=26=24 样本实测恒定、控制往返 T0=329、R01 复证）→ VALIDATION_HEAD
838dcc7（T=332=T0+3、enabled=true）全量全绿（冻结 diff 零差异、live bundle
482387B、第二树全绿且 bundle 逐字节 IDENTICAL）→ run-treasury 恢复撞上
restart_interval=3600 滚动重启主循环重置期，5 秒通道判停：零样本、零 send、
停止路径 3010ms 全 7 PID 确认（本轮修复首次真实完整实证）、控制槽撤装
（attempted=false 保留）。按纪律不改 ID/T 不 rearm，实验关闭；再次实机须
新任务书（须携带滚动窗口教训：正式窗口前重启引擎树或核对 restart_interval）。
enabled=true 仅对装载该 bundle 的世界有意义，不构成后续实验授权。证据：
`evidence/terminal-transfer-treasury-integration-i/`（含
treasury-integration-i-report.md 与 formal-window/root-cause-restart-interval.md）。

状态：**Execution 轮已运行（2026-09-09，判读 ENGINE_LAB_INCONCLUSIVE：
T=557 门禁前置拒绝 shard_mismatch、零发送）；Calibration Rerun（同日）
完成严格 shard 门禁恢复（C01）、独立配置核对（C02）、纠错（C03）与
**实机复验（S01–S05，已授权；再次判读 ENGINE_LAB_INCONCLUSIVE：T=201
被门禁以 `no_control_record` 前置拒绝——武装控制记录写入 db.users.memory
而真实 runner 从 env 层 `memory:<userId>` 装载 Memory，单次 send 未消费、
零交易、零资源变化；按纪律不重武装不换 T）。当前 labConfig 为实机复验轮
绑定配置（lab-run1-cal-0002，该世界已清理）；再次复验须新任务书。**

**Control Remediation I（2026-09-09，离线完成、实机 AUTHORIZATION_REQUIRED）**：
按用户附件实现包（基线 d69726a）原样应用 17 文件——R01 env Memory 控制工具
（连接时核对安装字节中 env.get/set MEMORY 通路、复用冻结 controlRecord 语义、
initialize/arm/disarm 各恰一次 env 写、storageConfirmed≠playerConfirmed 分离）、
R02 预检完整性修复（calibrationCheck.ts 为唯一既有修改：tick 合法唯一/逐样本
完整+稳定/报价逐样本可读/T≥T0+3 暂停点公式）、R03 停止控制器（窗口/180 秒先到、
≤1 秒暂停请求、5 秒稳定确认、有界进程树兜底）与 83 用例 Node 测试。Agent 独立
增补 R02 +7 / R01R03 +6 失败输入后：IMPL_HEAD b3207f9、预算 243/1497（PASSED）、
VALIDATION_HEAD d0103c9、正式回归与第二树全绿（六产物 IDENTICAL）、冻结×6 零
差异。实机 S01–S06 的范围确认未获答复，未启动任何服务（send 调用确定 0）；
工具就绪，获授权后可从 S01 直接开始。证据：
`evidence/terminal-transfer-engine-lab-run-i-control-remediation-i/`。

**Engine Continuation 0001（2026-09-09，实机执行完成，判读 ENGINE_LAB_PASS）**：
用户经续接包（screeps-engine-continuation，基线 5773f1a）授权继续 S01–S06。
测试隔离性修正（8f62ed6）后，新一次性隔离世界 lab-run1-ec-0001（合成用户
lab-ec-user-0001、双 Terminal ec0001aa57000001/2、shard Forst、报价 26）完成
准备阶段绑定（378db97，占位 T=400）→控制往返（observe-false 两 tick 读
armed=false→arm 一次→observe-armed 两 tick 读 armed=true，暂停后 env=玩家读数
——上轮根因的 env 层通路实证修复）→facts T0=164→正式 T=167 绑定（7f47a0d）
→C02 真实预检 55/55→全量验证全绿（243/1497、budget PASSED、冻结×3 零差异、
第二树产物 IDENTICAL）→run-formal **一次正式窗口 23/23 tick（165..187）**：
T=167 恰好一次真实 terminal.send() 调用同步返回 OK(code 0)，T+1 起源 900H/
9990E/CD9、目标 100H、空位 −100，交易单 ID 三视图一致——**100H 转运到账**；
暂停请求延迟 ~6ms、撤装保留 attempted@167、进程树 7 PID 全灭端口清零（工具侧
PROCESS_STOP_UNCONFIRMED 系其确认回路随树同亡，独立复核解决）。重要发现：
报价 26（runner 侧 worldSize=59）与实扣 10（engine_main 建房前启动的旧缓存
worldSize=12 折叠 range 9→3）分裂——standalone 运行时建房未整树重启引擎所致，
正式服不适用；门禁按报价保守放行、实扣在预算内。本 PASS 不等于国库生产
writer 集成。证据：上述根 `engine-continuation-0001/`。
编制日期：2026-09-08（Execution 轮 2026-09-09；Calibration Rerun
2026-09-09）。任务书：`treasury-terminal-transfer-engine-lab-run-I-execution.md`
（归档于 `evidence/terminal-transfer-engine-lab-run-i/task/task-brief.md`）；
Execution 接续任务书与 Calibration Rerun 任务书归档于各证据根 `task/`。
验收索引 S01–S06。

## 1. 本轮目标与授权门禁

唯一新增事实目标：由真实 Screeps runner 执行现有 single-shot，经真实
driver／processor 处理一次 W1N57 → W10N57 的 100H 请求，并从后续游戏观察
核对结果。

授权边界（任务书 §0）：启动本地一次性实验环境、创建合成 bot 与两个
Terminal、装载实验探针、最多一次发送 100H——这些动作**须用户明确授权后**
才执行。Execution 轮已按用户授权（会话明确回复「我给予你离线授权，
不接入线上服务器即可」）执行完毕并清理；该授权不自动延伸到新实验。

## 2. 离线接线交付（Lab Run I 离线轮完成）

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

`labConfig.ts` 仍为唯一编译配置来源。Execution 轮曾回填真实实验身份
（见 §2a，含已纠正的漏诊项）；Calibration Rerun 后当前编译值为**已纠错
的历史配置**（源 `b0254141a49b92c`、shard `Forst`、maxFeeEnergy 26），该
世界已清理、未绑定新实验，不得据此武装。合成示例值作为旧配置 fixture
（LEGACY_EXPERIMENT）保留于 probe.test，历史归档产物字节不再与当前产物
相等（§4.3 合法迁移）。

## 2a. Execution 轮交付（2026-09-09，已授权执行；含 Calibration 纠错标注）

用户授权来源：会话明确回复「我给予你离线授权, 不接入线上服务器即可」
（范围＝任务书 §0：本机一次性隔离环境、最多一次发送 100H、证据保存后
停止清理、不接入线上/正式服/PTR/真实账号）。实机结论见主报告与
`evidence/terminal-transfer-engine-lab-run-i/engine-run/`。

Execution 轮当时编译的实验身份（保留历史记录；**粗体标注为 Calibration
Rerun 纠错项**，纠错依据见
`evidence/terminal-transfer-engine-lab-run-i-calibration-rerun/corrections.md`）：

| 项 | 当时编译值 | 纠错标注 |
| --- | --- | --- |
| experimentId | `lab-run1-exec-0001`（描述 `lab-run1-exec-0001 W1N57 to W10N57 100H`） | — |
| shardName | `standalone-no-shard` | **漏诊**：真实读数为 `Forst`（窗口后探查实测）；sentinel 约定已撤销 |
| username / 房间 | `lab-synthetic-user`；W1N57 → W10N57（同一合成 bot 拥有） | — |
| 源结构 ID | `b0254105a49b92c` | **漏诊**：初始化/终态快照原件均为 `b0254141a49b92c`（engine-run/README.md:21 手写转写错字，回填未对照原件） |
| 目标结构 ID | `c61a4141a4a9fcb` | — |
| targetTick | 557（T0=554+3；窗口 555..577） | — |
| maxFeeEnergy | 10 | **过低**：窗口实际报价 26 > 10，门禁 `fee_over_budget` 拒绝属预算保护**正常工作**（若 shard 校验先行通过） |

真实配置下的三产物身份（`PREPARED_NOT_RUN`，装载前记录；sentinel 期
归档字节，现转作接受集合扩大反例）：observer 10193 字节／SHA-256
`04fac1c2e76c0efe95dbc30f5591b2031a299368cfe793a6c3ca8119b7d5d8c2`；
single-shot 29139 字节／`3266d7b280688bcbc2156adcf1b3876ca5034c52344f2bd0aa3cb1e8373988e3`；
main 8754 字节／`3e944685b0023b0a41d7dfb6fe80fedd2d08cfe96ef4f940a38ebc12f23cdbdc`。

**sendGate 无 shard 引擎兼容修复（历史提案，已撤销）**：该修复引入
`LAB_STANDALONE_NO_SHARD_NAME` 约定值，事实基础（引擎无 Game.shard）已被
窗口后探查推翻；且其「shard 存在时行为等价」的声明错误——在 Game 缺
shard、配置声明 sentinel 的同一输入下接受集合扩大。Calibration Rerun C01
已恢复严格真实 shard 身份读取并删除 sentinel 导出。详见（历史提案）
`terminal-transfer-lab-run1-shard-gate-compatibility.md` 与
`evidence/terminal-transfer-engine-lab-run-i/engine-run/api-incompatibility-game-shard.md`。

**执行结果（窗口结束后记录；含 Calibration 纠错）**：状态
**ENGINE_LAB_INCONCLUSIVE**。窗口 555..577 完整执行、observer 采样
23/23 tick、T=557 single-shot 在发送边界之前被门禁前置拒绝
（`shard_mismatch`）——单次 send 调用未消费、零交易、零资源变化、
控制记录保持 armed/attempted=false（撤装后 armed=false）。执行后只读
探查实证 `Game.shard={name:"Forst",type:"normal",ptr:false}` 存在。当时
报告的「编译期固定 maxFeeEnergy 的设计与报价漂移不兼容」结论**错误**：
窗口报价 26 大于固定上限 10 时拒绝正是预算保护正常工作；正确处理是绑定
新实验时以新鲜报价固定 cap（Calibration Rerun C02），不是扩大上限或实时
改写授权。报价 10→26 的观测成立，但其完整原因（地图生成、worldSize、
缓存之间的因果）尚未独立核实。按任务书 §4.5 不改 T/不重试；完整事实链
与判读见
`evidence/terminal-transfer-engine-lab-run-i/terminal-transfer-engine-lab-run-i-execution-local-validation.md`。

## 2b. Calibration Rerun 交付（2026-09-09，离线部分）

任务书：`treasury-terminal-transfer-engine-lab-run-I-calibration-rerun-implementation.md`
（归档于 `evidence/terminal-transfer-engine-lab-run-i-calibration-rerun/task/`）。

- **C01 严格 shard 门禁恢复**：`sendGate.ts` 撤销"缺 shard 以约定值放行"
  分支——缺失/null/name 非字符串/空串/读取抛错一律 `world_read_error`
  拒绝，仅实际存在的合法非空字符串参与精确比较；删除
  `LAB_STANDALONE_NO_SHARD_NAME` 导出/导入（历史归档与历史反例中的字面
  值不改写）。
- **C02 独立配置核对**：新增纯比较模块 `calibrationCheck.ts` 与只读 CLI
  `scripts/verify-lab-calibration.mjs`——读取 labConfig.ts 实际编译配置，
  与独立落盘的 facts（只读元信息采样 + 收集通道组装）逐项比较，一次报告
  全部不一致（不因首项失败省略其余；缺失记 missing 不当作健康）；绑定
  规则 cap=最新真实报价。测试 `calibration.test.ts` 覆盖场景 B–G
  （A 的门禁复现在 probe.test）。
- **C03 纠错**：本文件状态统一、shard-gate 提案标记撤销、纠错报告与旧
  证据缺证清单见新证据根 `corrections.md`；旧证据原件未修改。
- 离线自测相应变化：probe.test 25 用例（sentinel 专项反转为严格拒绝
  回归 + sentinel 期归档产物前后对照 + 场景 A 旧事故链四步 + 非 26 报价
  预算边界）；runI.test 12 用例不变（断言经 LAB_EXAMPLE_EXPERIMENT 传导）；
  calibration.test 6 用例（场景 B–G）。
- **实机复验（S01–S05，已授权执行，判读 ENGINE_LAB_INCONCLUSIVE）**：
  绑定 lab-run1-cal-0002（T=201、cap=26=本轮新鲜报价、C02 真实预检
  35/35）→ 第二轮全量验证+第二树全绿（7b91359）→ 三产物装载回读逐一
  一致 → 武装（98 字节）→ 窗口 199..221 observer 23/23 采样、T=201
  门禁前置拒绝 `no_control_record`（武装写入 db.users.memory 而 runner
  从 env 层 `memory:<userId>` 装载——envMemory="{}" 终态物证）→ 零
  发送/零交易/零变化 → 撤装/停止/取证/清理完成。完整证据链见
  `evidence/terminal-transfer-engine-lab-run-i-calibration-rerun/engine-run/`
  与主报告 §8。再次复验须新任务书（携带 env 层 Memory 装载根因）。

## 3. 授权后动作顺序（概要；命令参数以实际安装版本核对为准）

1. 独立实验目录安装固定版本官方 standalone server（`screeps@4.3.0` 组合，
   精确版本与来源按任务书 §3.1 核对归档）；监听仅本机。
2. 管理入口暂停模拟并确认静止；创建两个房间与一个合成 NPC bot；布置合法
   控制器与 Terminal 及 §2 初始库存；回读结构 ID 并归档初始化快照。
3. 真实 runner 连续执行 observer 取得只读基线（≥2 个不同 tick）；装配
   外部日志收集通道并证明可用；独立元信息采样取得 C02 facts。
4. 暂停固定 `T0`，读回真实身份填入 `labConfig.ts`（cap=新鲜报价）→ C02
   预检 → 提交 → 固定 VALIDATION_HEAD → 重建三产物并记录 hash → 装载
   回读核对模块字节。
5. 写入合法小控制记录（armed=true、attempted=false、完整 JSON ≤4096
   UTF-8 字节）并回读确认；武装前再执行一次 C02 正式命令；恢复模拟，让
   main×observer×single-shot 在真实 runner 中执行一次发送与 T+20 窗口观察。
6. 按实际基线判读（H/energy/空位/cooldown/交易镜像）；窗口结束立即暂停、
   切只读、撤销武装；停止完整进程组并只清理本次新建环境。

判读与状态语义（ENGINE_LAB_PASS／INCONCLUSIVE／MISMATCH／ENV_BLOCKED）
及停止边界见任务书 §5/§6/§7。

## 4. 证据

Execution 轮证据根 `evidence/terminal-transfer-engine-lab-run-i/`：
`task/`（两份任务书归档）、`environment/`（安装摘要与 npm view 记录）、
`engine-run/`（初始化/终态快照、console 原始流、无 shard 不兼容事实、
管理/收集工具）、`offline/`（离线验证与第二树复跑）、主报告（含授权
状态声明）。旧轮缺证清单与纠错见 Calibration Rerun 证据根。

Calibration Rerun 证据根
`evidence/terminal-transfer-engine-lab-run-i-calibration-rerun/`：
`task/`（任务书归档）、`corrections.md`（纠错报告与旧证据有界查找）、
`offline/`（离线验证 mainval/second-tree + 实机绑定轮 round2-validation/
round2-second-tree）、`engine-run/`（实机复验 S01–S05 全部原件，含
server package/lock 原件与判读）、主报告（离线交付 + 实机复验 §8）。
