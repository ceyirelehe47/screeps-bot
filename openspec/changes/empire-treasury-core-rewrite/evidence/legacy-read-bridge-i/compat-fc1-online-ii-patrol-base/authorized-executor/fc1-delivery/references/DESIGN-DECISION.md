# FC1 决策依据

## 用户已确认的变化

本轮以本会话关于“2 CPU 没有充分产品依据”的讨论和随后确认/任务包请求为依据：不再把 2 / 1.8 CPU 作为后续硬门槛；复用 R1，让完整读取和投影实际执行，再评估成本。旧交接稿里与这项新决定冲突的固定 2 CPU 条款仅作为历史依据保留。

不变项：独立真实读取、全部记录校验、eager index、四行/十六查询、默认 OFF、有限窗口/写入、精确恢复、独立运行确认；四点不等于生产切换批准。

## 仓库事实

固定仓库 ceyirelehe47/screeps-bot，compat e34a19fa72f71d9e6deeae5351222d16cef36231，refactor 7d3dbeed9a1c24729529cbec8a75d0cb8ae9454d。

R1 FINAL-VERIFICATION blob b8fc2c07e81c1120a12a3f34294ae67afaa43f10；recovery/result blob 84633393f03ef20f032aa914db3a67f9f4f13865。R1 原结果 4 raw / 4 accepted / 0 complete，不改判。第一点前缀 2.8842814000017825；可观测最大含原主报告尾部 3.8434630000047036；不是完整投影路径成本。

src/main.ts 的 treasuryCompatRead 调用位于 spawnWork、creepWork 与 inventory shadow 之后、cpuProfiler.flush 之前；其后的 flush 与引擎序列化尚有成本，不能忽略。

## 公开 API 核对

官方 CPU 文档：https://docs.screeps.com/cpu-limit.html
官方 API：https://docs.screeps.com/api/#Game.cpu

CPU 是计费时间；tickLimit 表示当前 tick 可用上限，limit 是持续配额，bucket 是累积余量。FC1 使用真实本 shard 的 native 读数，不把账号级 WebSocket CPU 整数当作本 sampler 的成本。官方文档不要求某个子系统必须低于 2。

## 工程假设，而非已测结论

10 CPU 是以 R1 已测约 3.8435 为参考，再给未知的完整投影与冷路径留有界空间的首轮探索额度；25 与 55 是结合历史 19 CPU 级同步尖峰的明确保护配置。它们不是统计上界、永久预算或新成绩线。若不足，本轮仍安全终止并保留实际读数，不自动加大。

成本收据自身的最后尾部、后续 flush、非采样 tick 调度与更长周期 bucket 收支仍未知。不会以四点自动批准长期部署。
