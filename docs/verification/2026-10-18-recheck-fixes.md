# 98e56f2 复查问题修复

本轮基于 `98e56f29`，对应用户提供的 `recheck-98e56f2-2026-10-18.md`。报告作为待核实证据，不把附件中的建议当成操作授权。用户在本会话授权继续修复、提交和部署；发布版本为 `2026.10.18-2`。

## 行为修复

| 复查编号 | 修复与边界 |
| --- | --- |
| R1 | 新增 `scoutStartedAt`，从本次侦察开始计时；换源、重新侦察、GCL/预定阻塞解除和防御暂停后重新计时。侦察超过 5000 tick 后暂停补员，保留旗、任务和活体；换旗名、重新插旗或换源可重试。 |
| R2 | 连续 100 tick 缺少 Lab、矿物或能量时，仅 `:war:` 配置解绑回收。非战争 creep 记录本次 boost 已跳过并直接工作，保留身份，不循环孵化；支援准备方据此释放 Lab。 |
| R3 | RESERVE 下战争续航从首次观察到投入证明起固定最多 1500 tick；补员、新一代和状态变化不能延长期限。解除 RESERVE 后恢复正常策略；本房 defense 仍阻止出征。 |
| R4 | 本 shard 与跨 shard claim 共用账号房间合计，包含所有已知 shard 的有效摘要；新版 payload 增加未截断总数。远端 tick 只用作推进标记，静止摘要按本地观察时间失效。原生 GCL 失败保留 500 tick 冷却，覆盖缺失/陈旧摘要及跨 shard 同时占领的竞态。 |
| R5 | PC 复用工厂的规范化配置、`targetQueue`、兼容 `targets`、字符串条目、库存与生产上限。全局默认关闭，房间关闭/drainOnly 不施放；只维持等级相符且已定级的工厂。已排队的旧任务也重新核验，避免自动永久定级。 |
| R6 | 支援方只为未带任何 boost 的有效 WORK 部件准备强化，与角色一致；已跳过可选强化的单位不继续占 Lab。 |
| R7 | 跨 shard spawning/in_transit 早退，以及已 claim/bootstrap 的活跃路径刷新 `lastReadyAt`，短暂阻塞不沿用任务创建时的超时基线。 |
| R8 | 无布局且没有 Container 时 Source Link 回退半径保持 2；有实际工作位时仍要求相邻，且 Link 必须激活。 |
| R9 | 有效 `CL_<源房>` 显式选择优先于旧源房锁定；显式源房防御时暂停，避免偷偷换源。母房防御/失守时殖民房可自行建立本地矿工。 |
| R10 | carrier 新建/重定向 accepted cargo 快照后同步更新同 tick 索引。battery 解压 loading 无论是否仍有来源，连续 500 tick 不到货均失败并撤板。 |
| feed 退货 | 只退源房 Storage，等待最多 50 tick；无安全仓位时解除责任并 drop，释放背包。不绕过 feed 目的 Terminal 的目标上限，不向矿点/升级专用 Container 填化合物。 |

R4 的房间预检依赖各 shard 发布摘要，不能代替引擎最终授权；缺失摘要时仍可能有一次 claim 失败，但已通过原生错误冷却及跨 shard 有界重试避免无限重派。

## 验证与证据

构建、类型检查及完整回归仅在已核实适用的 `dsh` 隔离目录 `/root/codex-jobs/20261018-screeps-recheck/` 执行。凭据只在本机内存读取，不传服务器。完整测试入口为无筛选的 `npm run test:verify -- --output-dir <隔离证据目录>`，构建显式清除 `DEST`。

复查旧行为的反例、定向回归、完整性检查、准确发布提交的服务器构建、完整模块回滚/读回及 shard1 console/socket 健康观察，统一保存在本机忽略目录 [monitor-data/recheck-98e56f2-20261018](../../monitor-data/recheck-98e56f2-20261018/)。最终结果见其中 `release-summary.json` 和 `发布验收.md`，避免发布后再提交证据导致 main 与实际运行提交分离。

本轮不把报告中尚未复现的 ResourceControl 承诺版本疑点当作已确认缺陷。旧 preload 扫描、Treasury 所有权查询、Memory 字节硬闸门与跨调用方快照共享仍是单独的性能工作；本轮没有用可能陈旧的缓存替换授权/容量判断，也不宣称线上 CPU 收益。

引擎依据：[账号房间 GCL 判定](https://github.com/screeps/engine/blob/master/src/game/creeps.js)、[OPERATE_FACTORY 首次施放定级](https://github.com/screeps/engine/blob/master/src/processor/intents/power-creeps/usePower.js)。
