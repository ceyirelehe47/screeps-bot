# Calibration Rerun——纠错报告与旧证据有界查找（C03）

日期：2026-09-09。任务书 §6。本文是**新建纠错文件**：旧证据根
`evidence/terminal-transfer-engine-lab-run-i/` 的全部原件（报告、console
JSONL、快照、归档 bundle、旧验证结果）保持原有字节与身份，未做任何原位
修改；本文件只做纠正陈述与缺证披露，并从现行说明
（`terminal-transfer-engine-lab-run-i.md`、
`terminal-transfer-lab-run1-shard-gate-compatibility.md`）链接。

## 1. 六项纠错

### 1.1 源 Terminal ID 漏诊（回填未对照原始快照）

- **事实**：旧轮初始化快照与终态快照原件（`engine-run/init-snapshot.json`
  与 `engine-run/final-snapshot.json`）中，W1N57 源 Terminal 的 `_id` 均为
  `b0254141a49b92c`；而 `engine-run/README.md:21` 的手写转写为
  `b0254105a49b92c`（少一个 `4`），主报告
  `terminal-transfer-engine-lab-run-i-execution-local-validation.md:51` 与
  当时的 `labConfig.ts` 回填均沿用该错字。
- **根因**：配置回填依据手写 README 的转写，未与原始快照 JSON 对照。
- **影响**：即使 shard 校验通过，T=557 也会以 `structure_mismatch` 拒绝
  （世界实际结构 ≠ 配置声明）——该漏诊与 shard 漏诊叠加，是旧实验
  INCONCLUSIVE 的第二重原因。
- **本轮处理**：现行 `labConfig.ts` 历史配置已纠正为 `b0254141a49b92c`；
  C02 预检要求 Terminal ID 来自独立 facts（快照/玩家视图）与配置逐项比较
  ——手写转写不再可能单独成为配置来源。新实验全部身份重新读取。

### 1.2 「缺 shard 分支行为等价」是错误结论（接受集合扩大）

- **事实**：sentinel 修复（3a9fceb）在其他条件合法、Game 缺 shard、配置
  声明 `standalone-no-shard` 的同一输入下放行（proceed），而撤销前的严格
  门禁（8c5459c）以 `world_read_error` 拒绝。接受集合确实扩大了，旧提案
  的"强度不降/行为等价"声明错误。
- **实证方式**：probe.test「Calibration C01 严格 shard 门禁」用 sentinel
  期归档产物（29139 字节／SHA-256 `3266d7b2…`，内嵌 sentinel 配置）在无
  Game.shard、其余条件匹配其内嵌旧配置的世界里实际放行 send=1，作为接受
  集合扩大的前后对照；现行产物同输入 `world_read_error` 拒绝。
- **本轮处理**：C01 撤销该分支并删除 sentinel 导出/导入；shard-gate 提案
  文档标记为「事实基础已推翻、实现已撤销的历史提案」。历史归档与历史
  反例中的字面值 `standalone-no-shard` 不改写。

### 1.3 「报价变化证明固定费用上限不兼容」是错误结论（预算保护正常工作）

- **事实**：旧轮正式窗口报价 26 大于固定上限 10；门禁 `fee_over_budget`
  （若 shard 校验先行通过）拒绝正是预算保护的**正常工作**，不是设计缺陷。
- **本轮处理**：不扩大上限、不实时改写授权、不跳过比较。绑定新实验时以
  **新鲜真实报价**固定 cap（C02 绑定规则 cap=q，预检强制相等；发送时
  仍由 gate 执行实时报价 ≤ cap）。现行 `labConfig.ts` 历史配置的
  maxFeeEnergy 更正为 26（该轮窗口报价），仅作历史记录一致性。

### 1.4 Forst 的实际采样时间边界

- **事实**：`Game.shard.name="Forst"` 来自旧轮**窗口结束后**的一次性只读
  探查 bot，不是 T=557 同 tick 的直接 shard 记录。T=557 的原始记录只有
  `shard_mismatch` 前置拒绝（console-window.jsonl 原行可证），没有引擎
  API 返回 ERR，也没有同 tick 的 shard 读数。
- **边界**：不得把后续字段拼进旧样本冒充原始观测。当前 `labConfig.ts`
  历史配置的 shardName=`Forst` 是**跨时间资料构造的纠错值**（新轮场景 A
  fixture 同此声明），不是 T557 的无损重放。

### 1.5 报价 10→26 的观测成立，完整原因未证实

- **事实**：报价读数 10（基线期，当时 worldSize=11）→ 26（窗口期）的
  **观测**成立；上一轮将 worldSize 漂移（11→58/59，环绕距离 3→9）作为
  解释，但地图生成、worldSize 计算、缓存之间的完整因果链**未独立核实**
  （静态分析曾漏掉 Game.shard 注入路径，同类方法不足以断言引擎内部因果）。
- **本轮处理**：不开展引擎机制研究；world size 仅作为 facts 中的诊断字段
  记录，不进入 C02 核对项，也不是绕过报价比较的理由。新实验在完成全部
  初始化后再读取稳定事实。

### 1.6 旧轮部分阶段证据不足（有界查找结果）

见下表（查找范围＝旧证据根全目录 + 旧环境目录状态核对；查找时间
2026-09-09 本轮）。

## 2. 旧原件有界查找清单（§6.2）

旧实验环境 `D:\code\screeps\lab-run-i-exec-env\` 已按旧任务书 S05 清理
（内容 0 文件；当时记录 Windows 延迟句柄致空目录壳残留），故环境侧原件
不可恢复。仓库内旧证据根的查找结果：

| 查找项 | 结果 | 实际来源与状态 |
| --- | --- | --- |
| server `package.json` 原件 | **缺失** | 仅存文本记录（`environment/install-summary.md`：安装根仅 `"screeps": "4.3.0"` 一条依赖） |
| server `package-lock.json` 原件 | **缺失** | 仅存 SHA-256 文本记录（`d95c2c12f74c6e2c4df6adf9025a191be4f5f4069b28366b8152714fc34c0ac7`，install-summary.md）——可验证曾有、不可复核内容 |
| npm install 日志 / `npm ls` 输出 | **缺失** | 仅文本摘要（"572 包，exit 0"）；版本组合（backend 3.3.0/common 2.16.0/driver 5.3.0/engine 4.3.0/launcher 4.2.0/pathfinding 0.4.17/storage 5.1.3）为文本记录，npm-view JSON 仅含顶层包元数据 |
| 解析与启动记录 | **部分** | install-summary.md 含启动命令、端口核对（21025-21027 仅本机）、进程 PID 文本（storage 147248、engine_main 141120、runner 143052→144352 等）；原始 stdout 未归档 |
| 活动模块完整回读 | **缺失独立原件** | 主报告文本声明"bots.reload 后活动 branch `t1788928675342` 三模块装载回读 UTF-8 重算 hash 一致"，但回读的完整模块内容/原始响应未归档；`engine-run/final-snapshot.json` 记录 activeBranch `t1788928675342` 为间接佐证 |
| 武装/撤装控制槽 JSON | **缺失独立原件** | 主报告文本（武装 99 字节回读确认 armed=true/attempted=false；撤装 218 字节 armed=false）；console JSONL 中无控制槽行（grep `armed`=0）；写入请求/回读原始响应未归档 |
| 交易表查询结果 | **部分** | 主报告文本"transactions 表 0 条"；查询请求与完整响应未作为独立原件归档 |
| PID/监听停止记录 | **缺失原件** | 主报告文本（launcher 树 taskkill、21025-21027 无监听、相关 node 进程数 0）；停止命令输出未归档 |
| 旧 README「后续内容」段 | **过期陈述** | `engine-run/README.md:24-27` 写"发送窗口完成后追加"，实际后续文件（console-window.jsonl、final-snapshot.json）已存在但 README 未更新；本文不改旧原件，特此说明 |

**处理**：以上缺失不伪造、不派生补造、不用新世界重演。旧轮 S01（安装
原件）、S03（模块回读原件）、S05（停止原件）的证据不足独立保留；旧轮
判读 `ENGINE_LAB_INCONCLUSIVE` 不变（真实 runner 与采样运行、发送未发生
的核心事实有 console-window.jsonl 与 final-snapshot.json 支持）。新轮
（若授权）按任务书 §10 同步保存全部对应原件，但新轮证据完整不能反向
补齐旧轮。

## 3. 本轮相关文件

- 纠错落点：`test/lab/terminal-transfer/sendGate.ts`（C01）、
  `test/lab/terminal-transfer/labConfig.ts`、`example.experiment.json`、
  `test/lab/terminal-transfer/calibrationCheck.ts`、
  `scripts/verify-lab-calibration.mjs`（C02）、
  `test/lab/terminal-transfer/{probe,calibration}.test.ts` 与 `fixtures/`。
- 现行说明：`terminal-transfer-engine-lab-run-i.md`（状态已统一）、
  `terminal-transfer-lab-run1-shard-gate-compatibility.md`（已标记撤销）。
- 旧原件：`evidence/terminal-transfer-engine-lab-run-i/`（零修改；
  本轮对 `sendGate` 的源码 diff 相对 STRICT_BASE 的解释见离线验证记录）。
