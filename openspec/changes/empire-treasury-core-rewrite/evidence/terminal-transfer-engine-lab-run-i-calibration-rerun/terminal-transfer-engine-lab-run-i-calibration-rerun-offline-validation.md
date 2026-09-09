# Terminal Transfer Engine Lab Run I · Calibration Rerun——主报告（离线交付 + 实机复验）

日期：2026-09-09。任务书：`task/task-brief-calibration-rerun.md`
（treasury-terminal-transfer-engine-lab-run-I-calibration-rerun-implementation.md
对话附件逐字归档）。本文先随离线交付（d3ca7e6）落稿；实机复验获授权
执行后追加 §8（时序与证据均如实分开）。

## 0. 结论与授权状态

**C01–C03 离线整改完成并全量验证通过；实机复验（S01–S05）已按用户
后续授权执行完毕，判读 `ENGINE_LAB_INCONCLUSIVE`：T=201 被门禁以
`no_control_record` 前置拒绝——武装控制记录写入 `db.users.memory` 而
真实 runner 从 env 层 `memory:<userId>` 装载 Memory（实证见 §8/根因），
单次 send 调用未消费、零发送边界、零交易、零资源变化；按停止纪律
不重新武装、不换 T。**

授权时序：本执行会话中的原始授权语句「我给予你离线授权，
不接入线上服务器即可」针对已结束的旧实验，不自动覆盖本轮新实验
（§0.1），离线交付时实机部分如实报 `AUTHORIZATION_REQUIRED`；交付后
向用户做**唯一一次范围确认**，用户明确答复「授权执行 S01–S06」
（范围＝新本机一次性隔离世界、合成用户、W1N57→W10N57、最多一次真实
terminal.send(100H)、不接线上服务器、证据保存后停止清理），随后按
任务书 §8 执行。

实机状态声明（§11.3）：服务曾启动（已停止，进程树 7 进程全杀、
21025-21027 无监听）；真实 runner 曾执行（窗口 199..221、observer
23/23 采样）；曾武装（98 字节回读确认；写入路径口径错误致游戏内
不可见，见 §8）；T=201 调用了 single-shot 且被 gate 前置拒绝
（`no_control_record`）——**未进入 send 边界，send 调用次数确定为 0**
（拒绝行是唯一相关输出，无任何 lab-send-attempt 行）；无同步返回；
未取得真实 100H 转运与交易（交易表 0 条、两端终态原值）；已停止、
撤装、取证、清理（空目录壳因句柄暂存，如实记录）。

## 1. 提交链与 HEAD

| 角色 | SHA | 内容 |
| --- | --- | --- |
| 起点 BASE | `bd9570d2c3cf8632202cfee4e3a96d95250add52` | 与远端一致、工作树干净（开工核对实际执行） |
| IMPL_HEAD（离线） | `13511d8dd95fc6044fe597b5a019c4a84699882a` | C01–C03 源码/测试/工具/配置/文档/任务书/纠错/准备件 |
| VALIDATION_HEAD（离线） | `f8631d031c8732b2f2fe1a0b18983a6fe489c384` | 预算滚动（241/1478→242/1486） |
| DELIVERY_HEAD（离线） | `d3ca7e6536e0457e601c7293349a151679d6e8cb` | 离线验证证据+主报告（离线版）+tasks，已推送 |
| IMPL/VALIDATION_HEAD（实机绑定） | `7b9135985ab3ce02192c853f051e76005562866e` | S02/S03 真实身份绑定+meta-probe 修复+checker 时序校准+fixtures 迁移；第二轮全量验证与第二树在其上完成（锚点 13511d8 仍含当前测试文件集，预算无变更） |
| DELIVERY_HEAD（实机） | 见最终回复 | 实机证据归档+本报告 §8+文档更新（证据追加提交，不要求 SHA 自引用） |

修改清单（`offline/mainval/full-diff-name-status.txt`）：`sendGate.ts`、
`labConfig.ts`、`example.experiment.json`、`probe.test.ts`（改）；
`calibrationCheck.ts`、`calibration.test.ts`、`fixtures/`×2、
`scripts/verify-lab-calibration.mjs`（新）；现行说明两篇（改）；
新证据根 task/corrections/tools-prepared/offline（新）；预算两文件（改）。
全部落在任务书 §3.1 允许清单内；§3.2 冻结文件零改动
（`freeze-lab-and-slice` 空 diff 证实）。

## 2. C01——严格 shard 门禁恢复（验收通过）

- `sendGate.ts`：撤销"缺 shard 以约定值放行"分支。现行为：`Game.shard`
  缺失/null/非对象、`name` 缺失/非字符串/空串、读取抛错 → 一律
  `world_read_error` 拒绝；仅实际存在的合法非空字符串参与与配置的精确
  比较（不同 → `shard_mismatch`）。无 `String()` 强转、无约定值替代。
  相对 STRICT_BASE（8c5459c）的完整 diff 见 `offline/mainval/sendgate-strict-base-diff.txt`
  ——唯一差异是 shard 读取块由隐式 TypeError 兜底改为显式结构拒绝
  （**收紧**，其余门禁顺序与资源检查逐字不变）。
- `labConfig.ts`/`example.experiment.json`：删除
  `LAB_STANDALONE_NO_SHARD_NAME` 导出/导入及错误依据；当前编译值为
  **已纠错的历史配置**（源 `b0254141a49b92c`、shard `Forst`、
  maxFeeEnergy 26），明确标注"该世界已清理、未绑定新实验、不得据此
  武装"。历史归档与历史反例中的 sentinel 字面值不改写。
- 测试（probe.test 23→25）：
  - 「Calibration C01 严格 shard 门禁」：7 个畸形形态（缺 shard/null/
    name 缺失/非字符串/空串/shard 读取抛错/time 读取抛错）全部
    `world_read_error`；函数级+产物级均验证**零 send、控制记录保持
    attempted=false（不进入 attempted 写入）**；信息完整合法对照 proceed；
    **前后对照**——sentinel 期归档产物（29139B／`3266d7b2…`）在同一
    "无 Game.shard+其余合法"输入下放行 send=1，实证接受集合扩大及其撤销。
  - 「场景 A 旧事故链四步」：固定世界（源 b0254141…、目标 c61a4141…、
    报价 26、shard Forst）下 旧编译配置→`shard_mismatch` → 改 Forst→
    `structure_mismatch` → 纠正源 ID→`fee_over_budget` → cap=26→proceed
    （并锚定当前产物在同一世界 send=1）。fixture 声明为跨时间资料构造
    的离线诊断场景。
  - 「Calibration E 预算边界（非 26 报价）」：报价 37=cap 37 proceed、
    cap 36 拒绝、报价异常拒绝、cap 不被自动改大。
  - 既有拒绝矩阵（未武装/attempted/错过 T/超预算/结构/用户/tick）与
    attempted/4096/main 单向依赖保护全部原样通过。

## 3. C02——独立配置核对（验收通过）

- **实际比较实现**：`test/lab/terminal-transfer/calibrationCheck.ts`
  （纯函数、零 I/O、零游戏权限；类型外零导入）——读取编译配置与独立
  facts（形状 `CalibrationFacts`：≥2 样本的玩家视图+暂停+管理时刻+来源
  声明）逐项比较，35 个核对项分 7 类（experiment_scope/world_user/
  endpoints/resources/quote/time_stability/provenance），**一次报告全部
  不一致**；缺失记 `missing`（无法核对），任何 fail/missing → 整体 fail。
  绑定规则 cap=最新真实报价（不等即 fail；发送时仍由 gate 独立执行
  实时报价 ≤ cap）。worldSize 仅作诊断字段不参与核对。
- **CLI**：`scripts/verify-lab-calibration.mjs`——转译求值
  `labConfig.ts` 实际导出（不把手写 JSON 当权威），记录 facts/labConfig
  的 SHA-256 与仓库 HEAD（codeSource 由 CLI 从实际输入注入），stdout
  输出完整 JSON 报告、stderr 人类可读摘要；退出 0/1/2。只读：不写任何
  文件、不连游戏。
- **测试**（calibration.test.ts 6 用例，场景 B–G 经实际比较实现）：
  B 三项同时错误一次齐报+逐项修复互不掩盖+基线文件字节不随 config 变化；
  C 配置侧自洽（labConfig≡example JSON）但事实不符仍拒；D 十组
  缺失/不可读/单 tick/缺健康字段/混用/陈旧/空样本全部不通过且首项失败
  不影响其余项报告；E 非 26 报价（30/29/31、非整数、负数）无硬编码；
  F 完整健康基线 35/35 通过；G CLI 真实命令（健康 exit 0、三项不一致
  exit 1 且三项齐报、坏输入 exit 2、输入文件字节不变）。
  场景 A（门禁复现）在 probe.test（见 §2）。
- **真实使用记录**：正式验证中实际运行并归档
  （`offline/mainval/cal02-healthy.*` exit 0；`cal02-mismatch.*` exit 1，
  stdout 为完整 JSON 报告）。**真实预检（武装前）未运行**——本轮无新
  世界事实、未绑定新实验；按任务书 §9.3 明确不得填写为已校准。
- 无新配置权威：labConfig 仍是唯一编译来源；CLI 结果不进入游戏运行时
  授权字段。

## 4. C03——纠错与旧证据处理（验收通过）

- `terminal-transfer-engine-lab-run-i.md` 重写状态区：顶部=Execution 轮
  已运行（INCONCLUSIVE）+ Calibration Rerun 离线完成；§2a 历史身份表
  逐项纠错标注；执行结果段更正"固定费用上限不兼容"错误结论；§2b 本轮
  交付；§4 证据索引更新（environment/engine-run 已有内容）。
- `terminal-transfer-lab-run1-shard-gate-compatibility.md` 标记为
  **事实基础已推翻、实现已撤销的历史提案**（含"行为等价"声明亦错误的
  纠正），指向本轮纠错说明；原文保留历史身份。
- `corrections.md`（新证据根）：六项纠错（源 ID 漏诊及根因——
  engine-run/README.md:21 手写错字 `b0254105`、快照原件均 `b0254141`；
  缺 shard 分支接受集合扩大；固定费用上限正确拒绝；Forst 采样时间
  边界；worldSize 因果未证实；旧轮证据不足清单）+ §6.2 有界查找
  found/missing 表（server package/lock 原件、npm install/npm ls、
  活动模块完整回读原件、武装/撤装控制槽原件、交易表查询原始响应、
  PID/监听停止原件=缺失或仅文本记录；README"后续内容"段过期陈述披露）。
- **旧证据根零修改**（`git diff BASE HEAD -- <旧证据根>` 不在改动清单）。

## 5. 回归验证（§9，全部在 VALIDATION_HEAD=f8631d0）

- 主验证（`offline/mainval/`，命令/退出码/stdout/stderr 逐条归档）：
  npm ci ✓；typecheck×2 ✓；生产 build ✓（dist/main.js 前后 SHA 一致
  `ded52ff6…`，实验构建未覆盖）；Jest 五组：lab 3/43、slice 3/23、
  treasury 35/597、defense 11/118、**full 242/1486/1486**（failed/
  pending/todo/runtime error 全 0）；**budget PASSED（242/1486）**；
  三产物构建+`BUNDLE_CHECK=OK`（manifest 自洽、内嵌 Forst/
  b0254141/cap26/tick557、example JSON=历史配置）；diff-check ✓；
  freeze-production（对 869149d）✓、freeze-root ✓、
  freeze-lab-and-slice（对 BASE）✓ 三组冻结零差异；sendGate 对
  STRICT_BASE diff 非空且内容=收紧；C02 离线对照两例按预期退出；
  验证前后 HEAD/工作区无变化。
- 工程事故披露：主验证脚本尾部一条断言把普通 `git diff`（恒退 0）误判
  为应退 1，在全部命令执行完毕后提前退出；已按正确语义补跑收尾断言
  （HEAD/工作区先行核对），原失败记录保留（见 `offline/README.md`）。
- 第二干净工作树（`offline/second-tree/`）：同一 VALIDATION_HEAD、
  独立 npm ci（依赖解析到本树）；LAB 3/43、Slice 3/23 全绿；三产物
  程序字节与主树逐一 IDENTICAL。

## 6. S01–S06——实机复验（已获授权执行，详见 §8）

离线交付时未获覆盖（当时如实报 AUTHORIZATION_REQUIRED，工具以
`tools-prepared/` 准备件就位）；交付后用户对唯一一次范围确认答复
「授权执行 S01–S06」，随后按任务书 §8 执行完毕——判读与完整证据
链见 §8 与 `engine-run/README.md`。旧轮纠错与新轮实验互不替代。

## 7. 边界重申

本轮即使未来实机 PASS，也只证明当前安装组合与限定正常场景，不自动放行
生产国库接入、故障场景或其他经济 writer；部署仍禁止（未执行
`npm run push`/`local`；`git push` 仅上传代码）。旧实验结论
ENGINE_LAB_INCONCLUSIVE 保持不变。

## 8. 实机复验（S01–S05，已授权；时序在 §0）

**S01（达成）**：新隔离环境 `lab-cal-rerun-env`（与仓库分离）；
`npm install --save-exact screeps@4.3.0`（exit 0）+ `npm ls` + 版本解析
原件归档（组合与上轮一致，lockfile SHA `d95c2c12…` 一致；**server
package.json/package-lock.json 原件本次入库** `engine-run/server-package/`
——补上轮缺证项）；init 专用世界（占位 steam key，认证路径未使用）；
`.screepsrc host=127.0.0.1`（21025 仅本机、21026/21027 回环）；启动
unset 全部部署变量；进程树与监听快照归档（launcher 98720→storage/
backend/engine_main/runner/processor×2）。启动前端口核对空闲。

**S02（达成）**：暂停→建房 W1N57/W10N57（gen-room 尾部 ASSET_DIR 图片
步骤报错、数据插入成功——直查 rooms/terrain/objects 证实）→合成用户
`lab-cal-user-0002`（id `c4c7544a1513ce9`）→ fixture（双 RCL8 归属+
双 Terminal 源 1000H+10000E/目标 0H+2000E，地形平原格）→
`map.updateTerrainData`+runner 重启（上轮同型经验）→管理侧停改。
meta-probe 只读装载（初版 `isActive` 误当属性读出 false——真实引擎
是**方法**；未武装阶段修复 v2 `2ec07978…` 并 reload 生效）。外部
收集器直订 `user:c4c7544a1513ce9/console` 实测收流 161 行：基线
tick 37..197 逐样本 shard=**Forst**、两端 my/isActive/controller
level8 同主、库存原值、**报价恒 26**（worldSize 59）、交易视图 0。
无其他经济 writer：用户清单仅系统 NPC+init 自带 4 个 simplebot+本
用户，交易表 0、两端结构唯一归属。再次暂停→在途 tick 完成→管理侧
复读一致，**T0=198**。facts 装配（tick 196/197，晚于最后管理操作）。

**S03（绑定与验证达成；武装写入口径错误——根因见下）**：绑定
`lab-run1-cal-0002`（描述 39 字符 ASCII）、shard Forst、双 Terminal
ID、T=201=T0+3、**cap=26=本轮新鲜实测报价**（数值巧合等于上轮窗口
值，但来源是本轮逐样本实测）；**C02 真实预检 35/35 pass**（实机
facts×绑定配置）；提交 7b91359（含 meta-probe 修复与 checker 暂停
时序语义校准——实机 facts 暴露"暂停确认 tick 允许晚于最后玩家样本"
的正常时序，均为未武装阶段修复）；其上第二轮全量验证全绿（
`offline/round2-validation/`：242/1486、budget PASSED、三产物
BUNDLE_CHECK=OK、三组冻结零差异、dist 未覆盖）+ 第二树复现
（`offline/round2-second-tree/`：LAB 43/Slice 23、三产物程序字节逐一
IDENTICAL）。装载：三产物（repoSourceCommit=7b91359）经 bots.reload
进活动分支 `t1788945341092`，从 `users.code` 集合**完整回读**模块
内容，UTF-8 字节+SHA-256 与待装载逐一一致（main 8392/de83d0c4…、
observer 9831/1dd18951…、single-shot 29177/8cf4b364…）。武装前终检：
世界对象与 facts 一致（reload 为代码装载、零世界对象变化——C02 的
lastAdminChange 语义按任务书 D 场景理解为 fixture/map 变更，代码装载
不使世界事实过期，此口径特此声明）、T 未错过、收集器活着、停止保护
就绪；C02 正式命令再跑 35/35。武装：控制记录 98 字节 ≤4096 写入
`db.users.memory` 并回读确认——**该写入口径即根因**（见下）。

**S04（窗口执行；gate 前置拒绝）**：恢复墙钟 09:17:19Z，180 秒停止
保护并行。窗口 199..221 **observer 23/23 tick 采样完整**；**T=201
single-shot 输出唯一拒绝行 `lab-precondition-rejection` reason=
`no_control_record`**——门禁顺序中控制事实先于 shard/结构/费用，
后三项本轮未被评估。零发送边界（无任何 lab-send-attempt 行）、
零交易、两端零变化。

**根因（实证）**：runner 每 tick 从 **env 层 `memory:<userId>`**
装载玩家 Memory（`@screeps/driver/lib/runtime/data.js:132`），engine
`game.js` 的 Memory getter 解析该字符串；`db.users.memory` 只是
backend 展示副本。终态物证：`envMemory="{}"`（游戏内始终为空）、
`dbMemory`=我们写入的武装记录原样并存。武装数据从未进入游戏运行时
——实验操作（管理侧写入口径）错误，非引擎 API 不兼容、非 C01 门禁
缺陷。上轮武装生效细节已不可考（上轮该项原件缺失，见 corrections.md）。

**S05（达成）**：窗口后请求暂停（T+20=221 之后 33 tick 的停止延迟
如实记录：主流程 45 秒轮询所致；窗口后 main 零发送零采样、终态原值
证实无侧影响）；终态取证（gametime 254、两端原值、交易 0、envMemory
/dbMemory 并存物证）；撤装（db 副本 armed=false 保留 attempted=false，
99 字节回读）；停收集器（流定格 217 行）→launcher 进程树 taskkill
/T /F（7 进程）→21025-21027 无监听、实验相关 node 进程 0；证据核对
可读后清理实验目录（内容 0 文件；空目录壳因 Windows 句柄暂存，会话
结束后可手动删）。

**S06（判读）**：`ENGINE_LAB_INCONCLUSIVE`——已进入实验、真实 runner
与采样运行、但被 gate 阻断（no_control_record）、无正常 100H 转运
证据；按 §4.5/§8 纪律不重新武装、不换 T、不清 attempted 重试。
单次 send 调用未消费；调用次数确定为 0（拒绝行是唯一输出）。C01–C03
验收不受影响（离线全部达成；本轮实机未触发 shard/结构/费用门禁）。
未来重开须新任务书，携带本轮根因（env 层 Memory 装载路径）重新设计
武装写入口径（候选：直接 `env.set(env.keys.MEMORY+userId, …)`，
或经 backend CLI `setPassword` 类同源通道——须新任务书评估）。
