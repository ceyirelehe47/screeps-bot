# PowerBank 测路调度饥饿修复与实服验证

## 结果

已发布 v15，E6N60 通过测路准入，来源为 E5N59，攻击手与治疗手已进入真实 Spawn 的出生流程。

原生 Game tick `74140427`、shard1、v15：

- 银行 `6ac362680f57623c7b457595`，6307 power、200 万血。
- 来源 E5N59，路径 `E5N59 → E5N60 → E6N60`；测得空载路径 54 格、战斗行军 54 tick、满载返回 55 tick。
- `admissionLastMeasuredAt=74140423`，证明获得了新测量预算。
- Spawn15 正在出生 `powerBankAttacker-74140425`，120 tick 身体，剩余 118 tick。
- Spawn20 正在出生 `powerBankHealer-74140425`，150 tick 身体，剩余 148 tick。
- 已生成带银行 taskId 和世代的两个小队配置。任务状态为 boosting，原生 creep 仍为 spawning；因此这里只确认准入与出生启动，不把状态名解释为 boost 已完成、已出发或已采回 power。

## 修复

原调度按任务插入顺序执行；全球每 tick 一次新测量的限制，使靠后的任务可能长期等待。Observer 的间歇视野进一步压缩其测量机会。

改为按任务最近实际消耗新测量预算的 tick 排序，未获得过预算的任务优先。失去视野、退避或资源不合格时不降低等待优先级，避免单纯轮转游标与视野周期产生错位。该时间戳随任务存入 Memory，global reset 后仍保留公平性；它只表示调度历史，不能替代路径证据。

仅重排 discovered 任务所占的位置，保留战斗、运输与终态任务的原有相对顺序。新测量仍限每 tick 一次、最多三次 PathFinder 搜索，每次 maxOps 6000。完整路径、所有 active Spawn、当前物资、视野和威胁门仍需通过。

本次从实服 v13 构建，只修改 package.json、PowerBank 任务类型、PowerBank manager 与对应回归测试。未合入此前未发布的 v14 CPU 候选。

## 服务器验证

服务器隔离目录：`/srv/screeps-treasury-build/powerbank-fairness-20261005`。构建、类型检查与全部测试均在服务器执行。

- 同一个复现场景：前八任务不断返回 incomplete，第九任务 E6N60 隔 tick 可见，来源有三个 Spawn。v13 在 80 tick 后仍为 discovered；修复后在 80 tick 内完成三个 Spawn 的真实模块测量并进入 preparing_boosts。
- 复现的 PathFinder 返回连续格路径，由真实测量模块验证步进、房间范围与安全回调；没有伪造 ready 标记。每 tick 测量和搜索配额均有断言。
- 测试还覆盖视野恢复后优先级、global reset 后重新收集路径证据、部分测量后出现威胁、部分测量后物资耗尽。
- 两份 TypeScript 配置检查通过。
- 相关 10 组、160 项测试通过。
- 全量 245 组、1764 项测试通过，约 562 秒。
- 最终构建通过，约 43 秒；保留既有循环依赖提示，本次没有新增模块 import。

## 发布身份与边界

- 线上基线提交：`efd9e7a1850635e4d741a944ba4621b9a04af184`。
- 修复源提交：`3993ac7fbcd54c4caa7efb54bc7cee40989df316`。
- 源码树：`800de3c959880fb52d4f3fb49e91590fe5f934cf`，构建时工作树干净。
- 构建标记：`2026.10.5-15+3993ac7@2026-10-05T10:49:29.875Z`。
- main.js：3648603 字节。
- 最终 SHA-256：`d7d304b9654b8c13d4202e1ec77b748e0651467a462c33fa6eeb824faec185b5`。

上线前核对账户、v13 原始代码字节、四 shard Treasury 无活动责任，以及既有 HUB、殖民支援与观察策略。保留私有备份后执行一次代码 POST，再独立 GET 校验字节相同；没有手动创建小队、调整任务优先级或覆盖 Memory。

本轮属于调度正确性修复，不能据此声称总 CPU 已下降。采集完成情况需要后续实际执行证据，本记录止于小队开始出生。

本机证据目录：`/Users/forst/Downloads/screeps-powerbank-fairness-20261005`，包含服务器日志、验证记录、冻结发布清单、上传与读回结果、私有上线前备份，以及原生 Game 的 `after-1-snapshot.json`。
