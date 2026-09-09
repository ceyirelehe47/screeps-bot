# Terminal Transfer Engine Lab Run I · Calibration Rerun——离线交付主报告

日期：2026-09-09。任务书：`task/task-brief-calibration-rerun.md`
（treasury-terminal-transfer-engine-lab-run-I-calibration-rerun-implementation.md
对话附件逐字归档）。

## 0. 结论与授权状态

**离线整改（C01–C03）完成并全量验证通过；实机复验（S01–S06）未运行，
状态 `AUTHORIZATION_REQUIRED`。** 本执行会话中的原始用户授权语句
「我给予你离线授权， 不接入线上服务器即可」是针对**已结束的旧实验**
（Run I Execution 轮，其一次性世界已停止并清理）作出的；按任务书 §0.1，
它不自动覆盖本轮新建一次性世界、最多一次 `send(100H)` 的新实验，且明确
禁止以"旧轮 send=0、额度未消耗"为由自动续跑。本轮因此只做一次范围确认
（交付时向用户提出），在此之前完成全部离线修复、测试、文档与提交——
本文即该离线交付；未编造任何新配置或新运行事实。

实机状态声明（§11.3）：本轮**服务未启动、真实 runner 未执行、未武装、
未进入 send 边界、send 调用次数不适用（未装载）、无同步返回、无真实
100H 转运与交易、无需要停止/清理的本轮资源**（上轮环境已在上轮清理）。

## 1. 提交链与三个 HEAD

| 角色 | SHA | 内容 |
| --- | --- | --- |
| 起点 BASE | `bd9570d2c3cf8632202cfee4e3a96d95250add52` | 与远端一致、工作树干净（开工核对实际执行） |
| IMPL_HEAD | `13511d8dd95fc6044fe597b5a019c4a84699882a` | C01–C03 全部源码/测试/工具/配置/文档/任务书归档/纠错报告/准备件（15 文件） |
| VALIDATION_HEAD | `f8631d031c8732b2f2fe1a0b18983a6fe489c384` | 预算真实收集与锚点滚动（241/1478→242/1486，基线=IMPL_HEAD） |
| DELIVERY_HEAD | 见最终回复 | 本主报告、验证证据归档、tasks.md（证据追加提交，不要求 SHA 自引用） |

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

## 6. S01–S06——实机复验（未运行）

未获覆盖本轮新实验的授权（见 §0）；服务未启动、世界未创建、未装载、
未武装、未发送。实机部分状态 **AUTHORIZATION_REQUIRED**（非 ENV_BLOCKED
——不存在环境失败事实，只是未进入）。新实验前置条件与工具准备：
`tools-prepared/lab-meta-probe.js`（只读元信息采样器，PREPARED_NOT_RUN，
装载时以实际字节 SHA 为准）+ 复用件与 facts 装配说明（`tools-prepared/README.md`）。
授权后按任务书 §8 顺序执行；旧轮纠错与新轮实验互不替代。

## 7. 边界重申

本轮即使未来实机 PASS，也只证明当前安装组合与限定正常场景，不自动放行
生产国库接入、故障场景或其他经济 writer；部署仍禁止（未执行
`npm run push`/`local`；`git push` 仅上传代码）。旧实验结论
ENGINE_LAB_INCONCLUSIVE 保持不变。
