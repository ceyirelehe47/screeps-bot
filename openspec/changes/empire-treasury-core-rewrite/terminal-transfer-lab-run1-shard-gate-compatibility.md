# Terminal Transfer Engine Lab Run I · Execution——sendGate 无 shard 引擎兼容修复提案（单列）

日期：2026-09-09。状态：**历史提案（事实基础已推翻、实现已撤销）**——
Calibration Rerun（2026-09-09，任务书 §4 C01）已通过新的线性提交撤销
本提案实现的"缺 shard 放行"分支，恢复严格真实 shard 身份读取（缺失/null/
name 非法/读取抛错一律拒绝，不用约定值代替读数、不做 String 强转）。撤销
依据与完整纠错见
`evidence/terminal-transfer-engine-lab-run-i-calibration-rerun/corrections.md`。
本文其余内容保留历史身份不改写，**不得再作为有效设计依据**；其中 §3 的
专项测试已反转为明确拒绝的回归用例（probe.test「Calibration C01 严格
shard 门禁」），sentinel 期归档产物转作接受集合扩大的前后对照。

> **执行后实证纠正（2026-09-09 窗口结束后）**：本文 §1 的事实基础被实测
> 推翻——一次性只读探查 bot 实测真实 runtime 的
> `Game.shard = {name:"Forst", type:"normal", ptr:false}` **存在**
> （hasOwnProperty 为 true）。§1 的静态分析方法（engine game.js 字面量
> 与 driver/bundle 全文搜索）没能覆盖真实注入路径，据此得出的「引擎无
> Game.shard」结论**错误**。后果：本实验配置按约定值回填 shardName，真实
> 读数 `Forst` 与之不符 → 窗口 T=557 门禁 `shard_mismatch` 前置拒绝、
> 零发送（详见主报告 §3/§5/§6）。当时记录的「本修复在 shard 存在时与
> 原实现行为等价（无害但非必要），保留不回滚」经 Calibration Rerun 复核
> **亦属错误结论**：在其他条件合法、Game 缺 shard、配置填写 sentinel 的
> 同一输入下，旧门禁拒绝而本修复放行——接受集合扩大了。以下原文保留
> 历史身份不改写。

## 1. 发现的不兼容事实

- 安装组合：`screeps@4.3.0`（`@screeps/engine` 4.3.0 / `@screeps/driver`
  5.3.0，独立 lockfile
  SHA-256 `d95c2c12f74c6e2c4df6adf9025a191be4f5f4069b28366b8152714fc34c0ac7`）。
- standalone 用户 runtime 的 `Game` 对象不暴露 `shard` 属性
  （`engine/dist/game/game.js` `makeGameObject` 的属性清单无 shard；
  `driver/build/runtime.bundle.js` 全文无 `Game.shard` 定义；官方文档的
  `Game.shard` 属官方服/PTR 语义）。
- 后果：`sendGate.ts` 原 `shardName = Game.shard.name` 直接读取在
  `Game.shard === undefined` 时抛 `TypeError`，被 try/catch 捕获后以
  `world_read_error` 拒绝——single-shot 门禁在该引擎上**永远无法通过
  shard 校验**，无法进入发送边界。该字段在离线轮始终以 mock Game
  （含 shard）测试，首次在真实 standalone 引擎上暴露。
- 完整症状与源码定位见本轮证据
  `evidence/terminal-transfer-engine-lab-run-i/engine-run/api-incompatibility-game-shard.md`。

## 2. 修复内容（最小 diff，不放宽保护强度）

`test/lab/terminal-transfer/labConfig.ts` 导出约定常量：

```ts
export const LAB_STANDALONE_NO_SHARD_NAME = "standalone-no-shard";
```

`test/lab/terminal-transfer/sendGate.ts` 的 shard 读取段改为：

```ts
const shard = (Game as unknown as { readonly shard?: { readonly name?: unknown } }).shard;
shardName = shard === undefined ? LAB_STANDALONE_NO_SHARD_NAME : String(shard.name);
```

语义保持：`shardName !== config.shardName` 仍然一律拒绝（`shard_mismatch`）。

- 配置声明具体 shard 名（如官方服 "shard1"）：引擎读出同名才通过；读出
  异名或读不出（约定值 ≠ 声明名）都拒绝——强度与原实现一致。
- 配置**显式**声明 `standalone-no-shard`：仅无 shard 引擎（读数落入约定
  值）可通过；引擎若读出任何真实 shard 名反而拒绝。
- 其余读取异常仍走 `world_read_error` 拒绝。

即：修复没有引入"跳过校验"的路径，只允许**配置显式声明**「本引擎无
shard」这一事实，并由配置来源（labConfig 唯一编译输入）控制。

## 3. 测试覆盖（probe.test 新增专项用例）

`Run I Execution 修复提案：standalone 无 Game.shard——配置显式声明约定值
才通过；声明具体名仍 shard_mismatch`：

- 通过分支：新产物 + 无 shard 引擎 mock + 当前配置（声明约定值）→
  send=1、attempted/stopped 写入正常。
- 修复前对照：**旧产物（归档字节，修复前逻辑）** + 无 shard 引擎 mock →
  零发送、`world_read_error`——直接复现并固定了不兼容症状，作为修复
  必要性的行为证据。
- 读数≠声明拒绝分支由既有「shard 不符」用例覆盖（shard 存在且异名 →
  `shard_mismatch`）。

## 4. 修改文件清单（本提案涉及）

| 文件 | 变化 |
| --- | --- |
| `test/lab/terminal-transfer/sendGate.ts` | shard 读取段兼容缺失（上述 diff）+ 头注释说明 |
| `test/lab/terminal-transfer/labConfig.ts` | 导出 `LAB_STANDALONE_NO_SHARD_NAME`；本轮真实配置 shardName 采用该值 |
| `test/lab/terminal-transfer/probe.test.ts` | 新增修复专项用例；`installLabWorld` 支持 `noShardRuntime` 选项 |

不修改 engine/driver、不替换 Game 对象、不自造交易记录；除上述 shard
读取兼容外 sendGate 全部门禁顺序与拒绝语义逐字不变。
