# Terminal Transfer Engine Lab Run I · Execution——sendGate 无 shard 引擎兼容修复提案（单列）

日期：2026-09-09。状态：**已实施于本执行轮固定提交**（发送之前；装载/武装/
发送均发生于修复后的验证版本）。本文按接续任务书 §2「必要的修复提案单列，
不在已尝试发送之后悄悄修改再发」的要求记录该项源码变化。

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
