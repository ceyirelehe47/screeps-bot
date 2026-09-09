# Engine Lab Run I · 真实 API 不兼容记录：standalone runtime 无 Game.shard

发现时间：2026-09-09（实机执行阶段，single-shot 尚未装载、未武装、未发送）。

## 症状（可复现）

`test/lab/terminal-transfer/sendGate.ts` 的 `evaluateSingleShotGates` 在第 61 行读取
`Game.shard.name`。本安装组合的 standalone 用户 runtime 中 `Game` 对象没有 `shard`
属性，该表达式抛出 `TypeError: Cannot read properties of undefined (reading 'name')`，
被同段 try/catch 捕获后以 `world_read_error` 拒绝——single-shot 门禁在该引擎上
**永远无法通过 shard 校验**，无法进入发送边界。

observer 基线不受影响（不读取 Game.shard）。

## 实际安装身份

- 聚合包 `screeps@4.3.0`（npm 精确安装，独立 lockfile
  SHA-256 `d95c2c12f74c6e2c4df6adf9025a191be4f5f4069b28366b8152714fc34c0ac7`）
- `@screeps/engine` 4.3.0、`@screeps/driver` 5.3.0、`@screeps/backend` 3.3.0、
  `@screeps/common` 2.16.0、`@screeps/launcher` 4.2.0、`@screeps/storage` 5.1.3
- Node v22.19.0 / npm 10.9.3 / Windows 10 x64
- 解析路径：`D:\code\screeps\lab-run-i-exec-env\server\node_modules\@screeps\*`

## 源码定位（只读取证，未修改引擎）

- `engine/dist/game/game.js` `makeGameObject` 组装的 Game 顶层属性为
  map/gcl/gpl/market/resources/getObjectById/notify/cpu 等，无 `shard`；
  全文件无 shard 属性赋值。
- `driver/build/runtime.bundle.js` 全文仅两处 shard 字样（power-creep 属性与
  intershard destination），与 `Game.shard` 无关。
- `engine/dist/processor/global.js` 的 `shardName` 仅用于 powerProcessor，
  不进入用户 runtime。
- 官方文档 [E3] 描述的 `Game.shard` 属官方服/PTR 语义；本 standalone 组合
  未实现该全局。

## 处置

按接续任务书 §2「必要的修复提案单列，不在已尝试发送之后悄悄修改再发」：
修复以单列提案（见 openspec 变更内修复提案文档）+ 最小源码 diff +
测试覆盖呈现，在固定 VALIDATION_HEAD 内完成，先于任何装载/武装/发送。
修复不放宽保护强度：配置必须显式声明「无 shard 引擎」约定值才放行，
任何其他 shard 不匹配仍拒绝。
