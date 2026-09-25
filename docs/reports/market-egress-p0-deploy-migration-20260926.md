# 市场 P0：shard1 上传与 r5 策略迁移实录（2026-09-26）

## 授权与写入边界

用户批准将市场 P0 代码推送至正式 shard1，随后明确批准上传所需的 V3 r5 cfg 更新及原有 `proposeMarketBaseResourcePolicyMigration → acceptMarketBaseResourcePermit` 配套迁移；授权不含新 lane 放行或市场成交。全过程使用 `ceyirelehe47/screeps-bot` 的 `codex/market-egress-p0`，未触碰 Treasury 或 Observer/PowerBank 候选，未重跑 FC1。写入结果不明时只读对账，不自动重发。

上传前 tick `73942410`：线上 tag `2026.8.29-6+5cef62c@2026-09-24T15:04:28.806Z`，默认 `main` SHA-256 `62a993bf917f1a74ef708584eaee1fc3d2deb5aaf8b0c751f8f9d72ff3c08032`，V3 cfg r3、permit epoch 4/head `csh1:e5702c7142f56dae39cc8d0526147aaa`，WAL pending 为零、quarantine 为零、receipt head `csh1:37a84f860991c5d15b225b506f4938b6`，历史确认 6 笔共 6,000 X。原 `main` 字节已单独保存到本机临时目录并验证 SHA。指定 shard1 的 console 探针在 tick `73942456` 通过。

## 逐动作与对账

| 阶段 | 已执行结果 |
| --- | --- |
| 首次上传 | 从干净提交 `b0e813e8` 执行一次 `npm run push`，工具回读默认 `main` 内容一致；独立 GET 再核对为 SHA-256 `f8a06a20ca0232fe69e89e63dcc90a13da6763951e2a97f0fbbebdca286816aa`，runtime tag 对应 `b0e813e`。 |
| cfg 更新 | shard1 console 接受一次写入，operation ID `6ab6d9544086a30013e99c4c`。独立 Memory 读回确认 r5、七资源 hard/economic 与 [预部署报告](market-egress-p0-predeployment-20260926.md)一致，`minDirectOrderNotional=451000`，mode/capability/canary 未变。 |
| 首次迁移提案 | operation ID `6ab6d982dcb087001366dc90`；审计实际拒绝 `market_base_migration_new_or_changed_grant_must_be_shadow_suspended`。没有生成 proposal，permit 仍 epoch 4，WAL head 和 6,000 确认量未变。原因是旧校验只允许 armed canary 的原位重签，遗漏现役 47 条 `qualified/suspended` lane。未重发同一提案。 |
| 缺陷修复 | 在原分支提交 `3fff7cd7`，将同 lane、相同执行额度与保护参数的 `qualified/suspended` 也纳入受限重签；现役 r3 字段形状、qualified 与 canary 混合回归通过，类型检查及构建通过。第二次上传是经修复的新提交，工具回读与独立 GET 均一致；线上 SHA-256 `8543c0df586b8177effb324516a986a5c552462a324da83c91425885c29d4bb2`，runtime tag `2026.8.29-6+3fff7cd@2026-09-25T20:32:22.266Z`。 |
| 成功迁移提案 | operation ID `6ab6da80b0453d0013cd6cbc`；读回 `proposalId=csh1:1620e33e7e9c4f5ed3ccfea4586b71ab`、目标 epoch 5/head `csh1:3aacc17b913f549ef475929ee06fcec1`，目标 WAL receipt head 未变。 |
| 接受迁移 | 对上述精确 proposal ID 调用一次 `acceptMarketBaseResourcePermit`，operation ID `6ab6da9bb0453d0013cd6cc5`。读回 permit epoch 5，56 条 grant 仍为 47 qualified/suspended、8 shadow/suspended、1 canary/enabled；WAL receipt head 不变、pending/quarantine/blocker 均为空、历史确认仍为 6 笔 6,000 X；配置回退闩锁与 V3 runtime blocker 均清除。 |

## 上线后只读观察及未达验收项

2026-09-25 20:35 UTC、tick `73942590` 的正式监控：请求与生效均为 `direct`，cfg r5、permit epoch 5、最新 V3 planning `complete=true` 且 `blocker=null`；原始买单 20、当轮 eligible 11、`selected=null`。V3 仍仅开放 E6N59:X，而该房 X 约 71k 低于 100k 储备，故当前没有可售余量。没有本轮真实交易，累计确认仍停在历史 6,000 X。八房合计空位约 389,433，仍有五房 emergency；短窗口空位波动不能替代持续净出货与恢复趋势。

首次迁移后的短暂观察曾出现两次 `market_base_cpu_ceiling_exceeded` 诊断；上述较后完整 planning CPU 为约 17.65，低于 25 ceiling，没有持续 blocker。继续按真实成交、WAL 对账、每房 storage+terminal 空位、Energy 净流入与保护储备观察。**本轮已完成上传与策略迁移，尚未完成 P0 真实出货验收。** 新 lane 放行、市场成交或提高现有全局 12,000/30,000 tick 额度，均不属于此次授权。
