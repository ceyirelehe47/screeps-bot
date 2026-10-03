# PowerBank 动态观察与实际测路优化

日期：2026-10-03。实现工作树：`codex/treasury-t4-architecture`。版本：`2026.10.3-7`。

## 当前防卫能力

已有攻击兵与治疗兵配对、治疗和完整战斗部件检查，危险房间避让，以及失联/停滞的生命周期处理。攻击兵攻击目标仍是 PowerBank；当前没有主动攻击敌方 creep、按敌方火力撤退或护送运输兵的战术。

本轮增加的是新任务准入保护：当前可见目标存在有效敌方 ATTACK、RANGED_ATTACK、HEAL，敌方 PowerCreep 或能力未知的敌方实体时，保持 discovered 并记录 `target_combat_threat`，阻止任务进入 Spawn/Boost 准备阶段。纯 MOVE 侦察兵不按战斗威胁处理。该保护不等于已投入小队具备 PvP 自卫，也不持续拦截已获准任务的所有后续投入。

## 观察与测路

- 移除 `E0N60` 至 `E9N60` 固定名单。按当前己方 RCL6+ 来源周边半径10生成高速房并集，处理 E/W、N/S 零轴、世界边界和封闭房。发现入口和角色入口只检查合法高速房，已接受任务不依赖当前覆盖集合。
- Observer 消费当前可见房间并发布观察；缺视野的 Harvest 只排队复看，不覆盖 Observer 当 tick 已发布的意图。每个 Observer 每 tick 最多一个观察，跨 Observer 去重。复看请求上限64、25 tick 清理，普通轮巡失败继续推进。
- Scout 使用所有来源的搜索并集补盲；无来源上下文的旧 Scout 才使用稳定原点。选侦察起点使用房间直线距离，避免等待出生时为所有房间组合反复调用 findRoute。
- 目标当前可见、Bank 身份确认且无战斗威胁后，从每个合格来源的实际 active Spawn 测量。限定安全房间走廊，要求路径完整、逐格相邻且实际抵达同房 range1；分别测战斗去程、空载运输去程、满载名义来源返程。
- 根据身体、道路、平原和沼泽计算旅行时间，接入来源排序、Spawn 时间线、战斗 TTL、运输出发、增援、travelling watchdog 和状态输出。所有合格来源及 active Spawn 测完才选择，每个来源取保守时间上界。
- 每 tick 最多一组测量、每组最多三次 PathFinder，每次 maxOps6000；heap 缓存64项、TTL100。端点、路线、危险集合、身体、可见性和可见拓扑变化参与缓存键。预算等待不占缓存；incomplete 保持等待重试，Bank 绝对截止始终有效。
- 新任务保存可选 `pathDistance`、`combatTravelTicks`、`haulerOutboundTravelTicks`、`haulerReturnTravelTicks`。旧活动任务缺字段沿用房间数估算，不因这次改动中止。

不可见中转房只具地形证据，测量不证明其当前完整结构、交通或未来敌情。满载返程估算以名义来源接收设施为终点，备用交付房仍执行角色实时容量、TTL、owner 和财政围栏检查。观察意图在下一个游戏 tick 提供视野；主循环 Observer 位于 Harvest 前，因此 Harvest 请求可能经历下一次调度及其后一个 tick 才取得视野。

## 运输修复与反例

旧 Hauler 在中间房返库时重放 source→middle→bank 正向路线，导致转向 Bank；空载返矿又未通过 mount 协议切回拾取。服务器旧源码反例运行结果为原有2例通过、新增4例失败，保留原 JSON/日志；初版修复同六例全部通过。

随后补齐无 `routeRooms` 的旧 encoded 参数，以及任务已清理、仍带 Power 的救援搬运方向。当前到目的地在旧走廊内时截取或反向，走廊外动态寻路；真实 `.work()` 卸货、返矿、第二次 pickup 的测试保留。owner/generation、实际投递计量、备用容量和 TTL 门保持。

Observer 看到他人攻击导致 Bank hits 下降时，discovered 只更新进展时间，不清掉威胁/测路等待及重试时间；防止等待超过500 tick 后错误恢复旧 stage timeout。活动任务的进展处理及绝对 Bank 截止仍执行原协议。

## 正式服只读证据

本轮先运行 monitor，再通过 CLI/API 读取身份、代码、Memory 和8个房间对象。正式快照为 2026-10-03 09:32:44–09:32:48 UTC，shard1，观察 tick74097710/74097711：8个 RCL8 房间各有1个 Observer，旧 runtime 仍只覆盖固定十房；有2个 PB 任务、6名战斗成员。两任务路线分别为3房和4房，说明中间房返程兼容具有实际意义。

这是11次 GET、0次 POST、0次业务写入。房间和 Memory 非原子联合快照，不证明 `isActive()` 或完整 heap。该时点正式 main SHA 为 `1bf02d8415f552239dd034865c4e62d5c6a00a978af36f78b64640ea05f6f061`；本轮候选尚未上传。

## 服务器验证

初版候选 `f077d89ea5f877ac10fe80a8ab80a77b6ee9ea67` 的运行类型检查 exit0，测试类型检查 exit2：Scout 测试赋值只读 Room.name；测路测试将简化 profile 直接断言完整类型。原失败日志与结果保留，未启动该版全量 Jest 或构建。

两夹具问题、任务清理后的返程与观测等待修正进入候选 `30f1ae75386a723d17650a45c01c5badb18bff62`。该版双类型检查 exit0，但首次完整 Jest 为 exit1：225 suites 中217通过、8失败；1383 tests 中1354通过、29失败，421秒，零 pending/todo。原报告和全部失败保留，没有在失败后构建。

失败完整分类：Harvest 新夹具未初始化 RoomPosition（8例）；Scout/Search 未初始化 Game.map（16例）；runtime 新可选复看字段导致声明指纹变化（1例）；角色与任务目录边界要求项目内真实 @types 路径，依赖软链接使其识别为空（2例）；旧公开 egress 接口缺 ambient 声明（1例）；harvester 的占位夹具（1例）。

最后两项在旧 `a24f2a77` donor 使用物理依赖定向复现：2 suites/7 tests，5通过、同2例失败，exit1，23.4秒，源码与测试前后干净。随后只补四个已经实际安装的控制函数的准确 ambient 类型，以及 harvester 夹具的房间信息；不修改市场运行控制或 harvester 行为。

修正只初始化正确夹具，保留原有断言。Memory 守卫更新唯一 runtime 指纹，并增加复看字段可选读取、旧四字段 Observer 对象兼容的编译验证；其余 owner、imports、字段清单、Program inclusion 和深层 optional 校验保持。角色/任务目录断言保持，以最终隔离候选的物理依赖修正测试环境。

最终候选为 `f74973a166caa6ac5bbae34aee9175ec1137a5cd`。双类型检查均 exit0，原8项失败定向复验为8 suites/46 tests 全通过、exit0、零 pending/todo，58.8秒。角色与任务目录检查在物理依赖下保留原断言通过。OpenSpec help、status、apply instructions、strict validate 均 exit0。

最终完整 Jest 实际 exit0：225 suites/1383 tests 全部通过，其中 PB 为15 suites/104 tests；0 failed/pending/todo/runtime errors，完整发现集合与执行结果集合一致，执行一次。本机轻量复读原 JSON，逐项与当前225个 tracked 测试文件集合匹配。构建使用 `DEST=''`，实际 exit0，36.1秒，仅构建未部署。

构建完成后，取证脚本误认为 `dist/main.js.map` 必须存在而报 FileNotFound，postprocessor 原失败记录保留；没有重建或覆盖测试结果，随后按实际 dist 清单只读追加工件记录。此失败属于工件取证脚本，不能混作 Jest/构建失败或删除后改写为成功。

冻结 `dist/main.js` 为3461463字节，SHA `7f6d7a81ba86922429627324bd0ee7574328ff262ada4741ec9321806595ea22`；本项目实际源码映射模块为 `dist/main.js.map.js`（8960222字节）。只读补充完成记录 SHA `2ffbcbf65581d77dce0f0665e98e5ec0a978404b09da73949dae10337b7a9244`；初次 postprocessor FAIL `dd5c19…` 原件保持。

构建、类型检查和 Jest 全部在 dsh 新隔离目录执行。旧 Jest budget 脚本固定旧基线193 suites/683 tests，与当前新增测试集合不同；保留该旧合同，本轮按 Jest 原配置完整发现和实际 JSON 统计验证，不降低或跳过测试。

最终候选目录为 `/srv/screeps-treasury-build/powerbank-observer-path-20261003/candidate-r3`；Node22.22.1，2CPU，Jest 串行，独立缓存与物理依赖。依赖清单与 donor 相同，package-lock 仅根版本调整，SHA `a035b14f34cf81f11d2f3e794c698a04e8663138cbaa94ee5491b779123a7de4`。复制冻结 donor 依赖，不改写其源码；未重启实验服务或使用旧 R18 世界。

最终全量 Jest 峰值 RSS 为1804212 KiB，构建为1648384 KiB。这是服务器进程资源记录，不是正式服 tick CPU 或原生游戏旅行效果测量。

OpenSpec 1.4.1 在服务器独立 prefix/cache 安装，安装与版号查询 exit0；不全局安装。最终候选实际执行 status、apply instructions 和 strict validate，均 exit0。

CLI 实际为 `spec-driven`、`repo-local`，sourceOfTruth=`repo`；allowedEditRoots 仅最终候选目录，四项 contextFiles 均指向本变更的 proposal、design、tasks 与 delta spec。实现结束前原 instructions 为 ready、1/12；完成文档清单后另作仅文档的收尾验证，不重跑构建或测试。

## 证据位置

仓库外证据根：`/Users/forst/Downloads/screeps-powerbank-observer-path-20261003/`。

- `live-readonly/summary.json`：正式只读快照。原始账户/Memory/代码/房间文件按私有权限保存，不纳入 Git。
- `hauler-baseline-red-results/`：旧源码2 PASS/4 FAIL。JSON SHA：`d86d246be22e317bac9e4f98af63300477de7cef129825c5bc28aa509ef6f29d`。
- `hauler-green-results/`：初版6 PASS。JSON SHA：`6206d0dec29cf010af629ad8018479969fb1452e1f1652995e78be512e495a21`。
- `openspec-install-1.4.1-results/`：安装日志、版号、prefix lock。lock SHA：`dd01609a74585cd3d4d26194f29e84f798ee1a3cb7f9617592b4f1e46df39989`。
- `candidate-r1-results/`：首次候选 dual typecheck 原结果，测试类型 FAIL 保留。
- `candidate-r2-results/`：首次225套完整 FAIL，Jest JSON SHA `9e4d3ec8298377884030c4b751aa7b35f7f088f6ca2cb5b96903751ed9c373ad`，日志 SHA `de4b36e376e28e91fe9e9aa355314ebbc56c9435d7fbf3d8453423e453fab3c6`。
- `donor-compatibility-results-r1/`：旧基线两项缺陷复现，Jest JSON SHA `a8cec9207caab174d9ff2458dca627ad8792621d9b52b6dd4ce062928f980a5b`。
- `candidate-r3-results/`：最终225套完整 PASS，Jest JSON SHA `ef2bd891f9751c76aaa515b23b64aae16dca8854148fbeae832f6a8781f3a3c1`；含定向 PASS、dual typecheck、OpenSpec、构建日志和只读工件补充记录。

此次不包含正式服上传或现场 PvP；isolated/mock 测试不能写成正式服生效或已证明线上 CPU。
