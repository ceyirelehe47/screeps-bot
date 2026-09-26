# Treasury Production T1：任务包最终工程状态（2026-09-25）

仓库为 `ceyirelehe47/screeps-bot`。任务包要求的 G1 线上只读兼容测量与 G2 默认关闭的生产接入候选、隔离引擎验收均已交付。新 Treasury writer 尚未在正式 shard1 灰度，首次灰度须另行独立审查和决定。

## G1：FC1 Online II

- 执行身份：`treasury-full-cost-FC1-online-II-2026-09-24`，运行 ID `4d9fb3da-29c7-4313-9d53-925fcbdbcb5d`，授权执行包指纹 `58e531ec76dbbbbb1d735a6885d28095fe1818de1c5de78d8a4f206043449606`。
- 源分支 `codex/fc1-online-ii-patrol-base` 最终 OFF 提交 `ab8ce87b5d668d1851ab18500774820855cca718`，源树 `25e0b6fb827f131be4c3215a97576f78a34a3455`。候选仅在此源上临时绑定测量配置；巡逻修复 `5cef62c5` 被纳入源和精确恢复基线。
- shard1 在 tick `73918900`、`73919000`、`73919100`、`73919200` 收到 4/4 有效业务报告与 4/4 完整成本回执，无重复报告或安全告警。候选 POST 一次，恢复 POST 一次；独立校验结论为 `CPU_DIAGNOSTIC_CAPTURE_VERIFIED`、`RESTORED_BYTES_AND_RUNTIME_VERIFIED`。
- 恢复后的线上 `main` SHA-256 为 `62a993bf917f1a74ef708584eaee1fc3d2deb5aaf8b0c751f8f9d72ff3c08032`，模块哈希为 `50295c19de66f7d34b2bd4e54f08317b212ea3a54054385a2abdeb6ef8aa74fe`，与测量前巡逻修复版本完全一致；恢复后的独立运行确认持续约 75 秒，含 20 帧 console 和 21 帧 CPU 数据。最终另做一次线上只读读回，仍为该版本。
- 4 个回执的 `preview` 调用区间 CPU 分别为 5.297、3.597、3.258、3.689。前三个点有后继回执支持的完整内部成本轮廓，分别为 4.455、2.691、2.514 CPU；第四点之后的尾段未观测，不估算为零。这两组数字计量边界不同，不直接相减。计量包含新探针自身成本，`resourceControl`/任务区间与父相位有重叠，不相加，也不把不同 tick 的工作量差异解释为因果提速。10 CPU 是本次暴露保护上限，不是正式性能目标。
- G1 原始账本、逐点数据、独立复算、排除项及 SHA 清单已归档至 `refactor/empire-treasury-rearchitecture` 提交 `c0d8da82b421caf8fc31e46d097892e2d0d25eaa`：[最终验证](https://github.com/ceyirelehe47/screeps-bot/blob/c0d8da82b421caf8fc31e46d097892e2d0d25eaa/openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-fc1-online-ii-patrol-base/online/FINAL-VERIFICATION.json)。本轮没有完成 12 点正式观察，也没有证明完整 Treasury 生产兼容性或性能因果收益。

## G2：最小 writer 候选与隔离引擎

- 产品源码提交 `69bf15cf2a533a8adc3f642f7de16bc529915d53`，分支 `codex/treasury-production-candidate-t1`；冻结 `main` 为 4,946,214 字节，SHA-256 `368196906dbd95dffe69bd830c2274988425fcef09d32a817eb0bfcdb6bb576c`。默认 OFF，正式 shard1 未上传此候选。
- 生产 `src/main.ts` 经 `resourceControl` 接入既有 H 转运任务、Treasury facade/kernel 与真实 `terminal.send`；非空旧任务和预约接入、共享 writer 排他、交易确认后扣减、drain 与 OFF 交回均有产品代码和定向回归。首次切片固定本账号 `E3N59 → E4N58`，一次最多 100 H、实时手续费至多 100 energy、持久配额最多一次 native dispatch；不会制造任务。
- 真实隔离 Screeps Engine 4.3.0 已从生产任务入口完成 100 H 转运、费用与两端库存对账、旧任务余量扣减、drain、旧 writer 交回及重启不重发。带 CPU 采样的第二轮合成复测也已完成；该 CPU 属隔离世界，不是 shard1 的正式预算。证据见 [隔离引擎验收](treasury-production-T1-engine-acceptance-20260925.md) 与其原始快照。故障注入中 `outcome_unknown`、冲突 writer 等由定向测试覆盖，并未声称在引擎现场发生。
- `npm run typecheck`、`npm run build` 和受影响的 Jest 组合回归已在候选冻结前通过。G1 与 G2 不共用产物、恢复方案或上线授权。

## 下一道门槛

对 G2 做独立代码审查、重新读取 shard1 当前任务/预约/终端/CPU 状态并核对构建大小与字节，再单独决定是否允许首次受限 writer 灰度。[灰度说明](treasury-production-T1-first-gray-20260925.md)列出 OFF → shadow → canary → drain → OFF 的前置、止损和交回规则。G1 的四点诊断及恢复不构成 G2 上线许可；本轮没有执行 G2 正式资源动作。
