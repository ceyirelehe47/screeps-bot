# E3N54、E4N57 殖民与 E1N57 T3 支援

日期：2026-10-05（Asia/Shanghai）。目标 shard1，账号 forster。

## 执行范围

- 建立 `CL_E1N57_E3N54` 与 `CL_E1N57_E4N57` 两个殖民标记，由 E1N57 的现有殖民流程侦察、认领、建设并交接。
- 每个已认领的目标房间维持一名额外支援单位，身体为 15 WORK、5 CARRY、15 MOVE；15 个 WORK 在 E1N57 完成 XGH2O 增强，每名需要 450 矿物、300 Lab 能量。
- 支援空手出发，抵达后使用目标房间的能量执行建设、维修和升级。XGH2O 增强的是升级能力，建设由其 15 WORK 执行。
- 目标房达到 RCL6 后锁存完成状态，停止补员，释放支援专属的增强 Lab 与任务，现存支援将剩余能量留在目标房并空手返回 E1N57。
- E4N57 路线指定为 `E1N57 → E2N57 → E3N57 → E4N57`；E3N57 的过境许可只对应此源房、目标房，当前可见的战斗单位、PowerCreep 或有能量敌塔仍阻止通行。

## 实现要点

新增 `Memory.cfg.colonizationSupport` 与对应运行状态。支援生命周期独立于殖民标记，避免普通殖民流程在 RCL3 交接、移除标记后提前终止 RCL6 支援。完成状态带 `runId`，房间之后降级不会自动重新启用这一轮支援。

支援使用扩展的 `colonizerWorker`。配置名称不含普通 `:upgrader:`，避免被只服务 RCL8 的现有 upgrader 管理器清理。沿用通用增强准备流程的 owner 隔离，清理只释放本次支援占用的 Lab。任务池升级席位计入实际到场的殖民 worker 与支援单位，保留原有任务容量和领取规则。

过境许可进入路线缓存键。增删许可后旧缓存不继续复用；其它目标的缓存合同不变。主循环阶段顺序未变，支援维护在现有 `flagControl` 的殖民阶段末尾执行。

## 来源与验证

发布从当前线上 v9 独立派生，此前的 CPU/HUB v10 候选没有包含在本次发布中。

| 项目 | 结果 |
| --- | --- |
| 线上基线 commit | `d1fce5fa210f940b0f915beee314af4a1802e63d` |
| 本次源码 commit | `483296e5044386058871fd0ddce67bbd30d9d3f4` |
| 源码 tree | `06cc0032bdcc0e821318c5b9068fed04e26999ea` |
| 构建版本 | `2026.10.5-11+483296e@2026-10-05T03:20:52.364Z` |
| 最终 main.js SHA-256 | `6f00645f3313668e2a7cc0f3a324947043d4a74cc50afc54a535188036e250c9` |
| 最终 main.js 字节 | 3,644,501 |
| 定向回归 | 12 套、57 项全部通过 |
| 全量回归 | 243 套、1742 项全部通过 |
| 构建类型检查、测试类型检查 | 均通过 |
| build | 通过，保留已有循环依赖提示 |
| 正式上传 | 一次 POST 被接受，独立 GET 的字节数与 SHA-256 完全一致 |

构建和全部测试在服务器隔离目录 `/srv/screeps-treasury-build/colonization-support-20261005` 执行。本机仅编辑、传输和执行 API 控制。发布前读取四个 shard 的完整 Memory，确认无待处理 Treasury 责任，保留 E1N57 的 TooAngel 三房共享清剿观察配置。上传前代码和 Memory 已备份在仓库外的权限隔离目录。

首轮原生 `RoomPosition.createFlag` 在不可见房间明确抛错，未建立标记；随后检查两个名称不存在，通过官方 SDK 对应的 flag API 各创建一次，并从原生 Game/Memory 读回。一次中间定向测试命令包含不存在的测试路径，已更正；表中最终定向与全量回归均是对冻结源码重新执行的成功结果。

## 线上验收

发布前 tick 74133802 的读回：E3N54 已认领，状态 `bootstrapping`；E4N57 状态 `claiming`，路线已经经过 E3N57。E4N57 的 Invader 预订由现有 claimer 清除，支援维护等待本方认领后开始补员。

tick 74133820 原生控制台确认两房支援配置启用。tick 74133838 原生控制台的 `lastDeployTag`、`lastDeployCommit` 与本次冻结来源一致，`lastDeployBundleHash` 为 `b9276675b5cef57d907acf64edbd9a1bd84c76ad89e1885bd0ba498047cbe76a`，与构建产物尾部记录的 append 前哈希一致。该值与表中的最终整个文件哈希计算范围不同，两者分别核对通过。

tick 74133852：E3N54 为本方 RCL1，已有普通殖民 worker 和两名 harvester 到场；额外 T3 支援 `colonizerWorker-74133821` 在 Spawn11 孵化（总 105 tick，剩余 74 tick），能量 0，配置身体符合预期。E4N57 的 Invader 预订剩余 1997 tick，claimer 已在目标房，支援状态为 `waiting_claim`，认领后自动补员。

tick 74133896：支援专属 Lab `69fe48e46318ad0a63a77fc0` 已通过常规搬运自动装入 450 XGH2O，Lab 能量 2000，足以增强全部 15 WORK；源房 storage 的 XGH2O 从 5000 变为 4550。此时支援仍在孵化、空载，增强尚未执行。

tick 74133930：`colonizerWorker-74133821` 已出生，全部 15 WORK 实际增强为 XGH2O，能量 0，`ready: true`，剩余寿命 1495。增强 Lab 消耗了 450 XGH2O、300 能量，专属增强租用状态已经释放；其它 Lab 仍为原来的 2000 能量。空载出生与全部 WORK 增强均已得到原生状态验证。

最终 tick 74133951：该支援已行进到 E1N57 `(31,41)`，离开出生位置 `(29,21)`，仍为全部 15 WORK 的 XGH2O 增强、能量 0，寿命 1474；正在向目标房行进。E3N54 支援状态持续为 `supporting`，E4N57 持续为 `waiting_claim`，两房配置与源房、路线许可读回一致。相关控制台采集窗口未记录原生错误。

达到 RCL6 的终止与返回规则已由回归测试覆盖；本次验收不将尚未发生的 RCL6 交接或 T3 支援抵达目标房报告为完成。

## 证据

- 本机：`/Users/forst/Downloads/screeps-colonize-e3n54-e4n57-20261005`
- 服务器：`/srv/screeps-treasury-build/colonization-support-20261005/evidence`
- 冻结发布清单：`release.json`；发布结果：`apply-result.json`；完整服务端验证回执：`server-evidence/validation-receipt.json`。
- 原生控制台的每个命令均留存 intent、HTTP 响应和 websocket events；写请求结果未知时不重放。

此前 CPU/HUB v10 候选需在本次 v11 来源上合并、重新验证后再发布；不能用旧候选覆盖本次殖民支援。旧候选的发布守卫绑定 v9 在线哈希，因此当前基线变化会阻止其直接发布。
