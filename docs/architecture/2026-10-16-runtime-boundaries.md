# 运行时依赖、严格类型与部署配置

基线为已发布的 `45571702`，发布记录提交为 `e723bdbe`。本专项在 `codex/architecture-strict-config-20261016` 独立开发；线上版本不随源码编辑改变。

## 模块边界

Treasury 的只读控制投影与启停、维护、执行器分开。`treasuryTerminalControlReadModel` 和 `treasuryContinuousOHReadModel` 只依赖状态验证及只读 fence；commitment bridge 与 runtimeServices 不再通过只读查询载入资源或合成执行器。

`synthesisReadModel` 持有配方归一化、库存及配置需求查询。`resourceControlReadModel` 持有快照、承诺索引、shadow epoch 捕获、Treasury 准备度及 donor 查询。高层合成与资源调度都依赖这些模块，不互相回调。主循环的阶段顺序和 Treasury 生命周期保持原样。

资源调度进一步分为 terminal 备货与恢复、旧市场操作及主调度。市场基础资源的双读规划、运行时 readiness 能力与执行编排独立；市场数据恢复、操作员授权与 tick 编排分开。旧文件保留原 public API 重导出，内部消费者直接引用所属模块。模块缓存和可变状态只保留一个持有方。

Rollup 将循环依赖警告升级为构建失败。不能以忽略警告或动态 require 绕开边界。

## TypeScript

`tsconfig.build.json` 开启 `strict: true`，覆盖全部生产 TypeScript。测试配置保留既有 mock 兼容性，仍单独执行类型检查；不把测试类型检查通过描述成测试代码全面 strict 化。

本轮修复可选 Memory 分支的返回类型、条件类型中漏掉的 NonNullable、不可见 room、尚未出生 creep 的 TTL、Store 对不支持资源返回 null、回调中的可变引用收窄以及生产 JS planner 的桥接声明。没有使用 ts-ignore 或全局放宽 Screeps 声明。

诊断计时器的 finally 满额 return 会覆盖业务结果和异常，改为跳过超限记录但保留业务控制流，新增满额返回值及异常回归。

## 房间与 shard

`src/config/deployment.ts` 集中部署身份和兼容默认值。普通孵化出口通过现有房间配置调整，例如：

```js
Memory.cfg.rooms.W9N9 = {
  ...Memory.cfg.rooms.W9N9,
  spawnExitDirections: { Spawn1: [RIGHT, BOTTOM] }
};
```

空数组表示交还引擎默认出口；非法值保留已知房间的安全默认。读取不创建 Memory、不缓存可变配置；移动或新建 spawn 无需改运行时代码。Hub、合成 donor、资源阈值及跨 shard 目的地仍由各自现有 Memory 配置/任务指定。跨 shard traveler 不再用 W0N0 掩盖缺失 portal。

`AUTHORITY_ROOMS` 与 `AUTHORITY_EXECUTOR_SHARD` 是既有签名协议的历史身份，集中配置但不接受 Memory 别名覆盖。Treasury facts、canary golden outcome、permit 与历史 lane 必须保持原字节身份。迁移这些授权需要关闭/结清旧责任、生成新策略与 permit，再验证部署；直接修改 Memory 房间名不能转移旧授权。此次集中化不自动重写线上配置或历史凭证。

## 验证

构建、类型检查、模块图核查及测试均在 `dsh` 的 `/root/codex-jobs/20261016-architecture` 隔离目录执行；本机仅编辑与传输。完整回归 262 套件 / 1983 用例通过，详细结果、源码身份和证据位置见[验收记录](../verification/2026-10-16-runtime-architecture.md)。
