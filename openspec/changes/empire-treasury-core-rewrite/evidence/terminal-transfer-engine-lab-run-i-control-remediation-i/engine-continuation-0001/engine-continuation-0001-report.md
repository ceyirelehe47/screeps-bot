# Engine Continuation 0001——实机执行报告（S01–S06，2026-09-09）

任务：`screeps-engine-continuation` 包（AGENT-CONTINUE.md，基线 5773f1a）。
授权依据：包内记载用户对「顺手收紧测试，然后继续现有 S01–S06」答复「继续吧」
（2026-09-09T14:49:47Z），范围限本轮一场实验（本机一次性隔离世界、合成用户、
W1N57→W10N57、100H、最多一次真实 `terminal.send()` 调用、180 秒/窗口先到停止、
不接线上服务器）。

## 判定：ENGINE_LAB_PASS（任务书约定口径）

准备（控制往返）、真实调用、后续世界结果、覆盖与停止均有充分材料：

| 事实 | 结果 | 关键证据 |
| --- | --- | --- |
| 玩家 Memory 往返 | ✅ observe-false 两 tick（160/161）读 armed=false → 一次 arm → observe-armed 两 tick（162/163）读 armed=true、attempted=false → 暂停后 env 记录与玩家读数一致 | control-roundtrip/labctl/03、04、05（console.jsonl 原始流 + roundtrip-result.json ready 无 issues + paused-snapshot memory） |
| 调用次数与返回 | ✅ **恰好一次真实 `terminal.send()` 调用**，同步返回 `{ok:true, code:0}`；控制事实 `attempted=true, attemptedTick=167, syncResult={ok:true,code:0}` | formal-window/run-formal/console.jsonl（pre-call/boundary/sync-return 三行）+ paused-snapshot memory + 撤装前记录 |
| 转运结果 | ✅ 源 H 1000→900（−100）、目标 H 0→100（+100）、源 energy 10000→9990（−10=实扣）、目标空位 298000→297900（−100）、冷却 0→9(T+1)→0(T+20)；交易单一 ID `e53e70c19072e81` 在玩家出向/入向/db 三视图一致（一笔转运）；description/route/amount 与配置逐字一致 | formal-window/run-formal/console.jsonl 逐 tick + paused-snapshot（transactions+objects） |
| 时间与覆盖 | ✅ 窗口 165..187 共 **23/23 tick 无缺口无重复**；send 边界在 T=167；结果首见于 T+1=168（不预设 T+1，本次实测即 T+1） | stop-result.json sampleTicks + console.jsonl |
| 停止与退出 | ✅ window_complete 触发后暂停请求延迟约 **6ms**（远低于 1 秒要求）；暂停确认（静止 tick 188）；撤装保留 attempted；进程树 7 PID 全部退出（131676/138500/138128/144640/145684/144252/121272，二次核对含 131676 复查 GONE——首查 alive=True 为查询竞态）；21025–21027 无监听 | stop-cleanup/s05-pid-check.txt、s05-final-process-ports.txt；工具侧 PROCESS_STOP_UNCONFIRMED 见下 |

工具 `run-formal` 自身退出码 1，原因是其进程树停止**确认**环节超时（其 storage
连接随被杀的树一同死亡，确认回路中断）；按任务书 §8「暂停返回、暂停标记、稳定
tick、最后进程退出不是同一个事实」逐项独立复核：进程与端口均清零，判据为实证
而非工具自述。`stop-result.ok=true/windowComplete/pauseConfirmed` 均真。

## 提交链

- `8f62ed6` 测试隔离性修正（包 changes.patch 原样应用，blob fd685c6c→ea6231cb；
  sensitivity 六条 matched 复核；定向 6/6、89/89、wrapper 4/4，数量不变）
- `378db97` 准备阶段身份绑定（占位 T=400；cal-0002 历史场景冻结至
  review-base-config.json；新增本轮真实 facts 副本 fixture）
- `7f47a0d` 正式窗口 T=167 绑定（VALIDATION_HEAD；本报告与证据归档于其后）

## S01 环境（environment/）

新目录 `lab-ec0001-env`（与仓库分离）；`npm install --save-exact screeps@4.3.0`
（exit 0，lockfile SHA `d95c2c12…` 与上轮一致，组合 screeps 4.3.0/engine 4.3.0/
driver 5.3.0/backend 3.3.0/common 2.16.0/launcher 4.2.0/pathfinding 0.4.17/
storage 5.1.3；package/lock 原件入库）。`.screepsrc host=127.0.0.1`；init 占位
steam key（认证路径未使用）。launcher 以**绝对脚本路径**启动（root 131676=
`node D:\...\lab-ec0001-env\server\node_modules\@screeps\launcher\bin\screeps.js
start`，满足工具 `belongsToEnvironment` 绑定；首次以相对路径启动的树已整树
终止重来并留痕）。监听仅回环：21025@127.0.0.1、21026/21027@[::1]。

## S02 控制往返（control-roundtrip/）

暂停→gen-room W1N57/W10N57（尾部 ASSET_DIR 图片步骤报错、数据插入成功——直查
rooms/terrain/objects 证实，上轮同型）→合成用户 `lab-ec-user-0001`（id
`48b86d847499b79`，官方 `bots.spawn` 自带 `env.set(MEMORY+userId,"{}")`——
真实 runner 初始化通路）→fixture（双 RCL8 归属+双 Terminal 源
`ec0001aa57000001` 1000H+10000E/目标 `ec0001aa57000002` 2000E、端点平原格）→
`map.updateTerrainData`+runner 重启。meta-probe（归档原件 2ec07978…）限时 45 秒
采集 41 样本（tick 119..159）：shard **Forst** 恒定、两端 my/isActive/RCL8、
库存原值、**报价恒 26**、交易 0；用户清单仅系统 NPC+4 simplebot+本用户（无其他
经济 writer）、交易表 0；暂停复读 T0=160、env Memory `{}`。

绑定 `lab-run1-ec-0001`（378db97）→构建只读 controlProbe（6ee4e58d…，四模块
固定图、PREPARED_NOT_RUN）→bots.reload 装载，活动分支 t1788969451203 **唯一
main 模块且字节 SHA 与产物一致**。工具序列（--host ::1 --port 21027 --pid
131676）：inspect（tick 160、Memory `{}`、槽 absent）→initialize（一次 env 写
98 字节 storageConfirmed）→observe-false（**恢复一次**，玩家 tick 160/161 读
armed=false，自动暂停 162，暂停后 env=玩家读数）→arm（原始 proof 一次
false→true，97 字节）→observe-armed（恢复一次，tick 162/163 读
armed=true/attempted=false，自动暂停 164，往返 ready 零 issues）→facts
（pauseConfirmedTick=164，样本 162/163，proof SHA 50d1b85b…）。

## S03 绑定与正式验证（binding-validation/）

首次固定 **T=167=T0+3**（窗口 165..187；占位 400 从未进入 send 路径）。提交
7f47a0d 后：**C02 真实预检 55/55 pass**（exit 0，repoHead=7f47a0d）。全量正式
验证（unset DEST）：双 tsc 0 错误；生产构建 dist/main.js `15c779bb…`；分组
回归 lab 4/54、Slice0 3/23、Treasury 35/597、Defense 11/118；全仓 **243/1497
全过**；budget PASSED；三组冻结零差异（lab/slice 入口与 mock vs bd9570d、生产
src vs 869149d、根配置 vs bd9570d）；正式三产物
（observer 10177B/4e78c48a…、single-shot 29523B/881b67c7…、main 8738B/
d1093880…，repoSourceCommit=7f47a0d）；dist 未被实验构建覆盖。第二干净工作树
（独立 npm ci）：lab 54、工具 Node 89、Slice0 23 全绿，三产物+example JSON
程序字节**逐一 IDENTICAL**（bundle-compare 末行；首行 DIFF 为路径笔误的废行，
已在次行以正确路径重比并追加 IDENTICAL）。

## S04 正式窗口（formal-window/）

三产物装载回读：活动分支 t1788972087004 恰含 main/observer/single-shot 三模块，
SHA 与产物逐一一致。`run-formal`：预检（armed proof+facts+C02 55/55+
formal-before 端点比对）→订阅握手→180 秒期限→**恢复一次**。窗口 165..187
23/23；T=167 observer 先行（pre-call 样本：源 1000H/10000E/CD0、报价 26）→
single-shot 三行：pre-call(fee=26)→boundary→**sync-return `{ok:true,code:0}`**
→T+1=168 起源 900H/9990E/CD9、目标 100H、交易入向+出向各 1。外部收集器独立
通道同步收到 23 样本+3 send 行（最后接收 16:42:12Z）。窗口完整后自动暂停
（静止 188）、终态快照、撤装（armed=false 保留 attempted=true@167、stopped=true、
166 字节回读）、进程树 taskkill。

## 重要发现：报价 26 与实扣 10 的 worldSize 分裂（standalone 环境特性）

同一公式 `ceil(amount*(1-exp(-range/30)))`（driver/engine 同源
`calcTerminalEnergyCost`），两端读数不同：

- **报价 26**（玩家侧 runner，145684 于建房后重启）：`driver.getWorldSize()`
  =59（全部 123 房），range=|W1−W10|=9（wrap min(59−9,9)=9）→ceil(25.92)=26。
- **实扣 10**（engine_main 144640 于建房**前**启动，未随 runner 重启）：其
  worldSize 缓存=12（启动时仅默认 121 房），wrap min(12−9,9)=**3**→
  ceil(9.52)=**10**。

即运行时 `db.rooms.find→common.calcWorldSize` 的进程级缓存在「gen-room 后只重启
runner」时分裂：报价端新鲜、扣费端陈旧。上轮仅重启 runner（地形缓存所需）且
send 被 gate 拒绝，故从未暴露。对本实验：门禁按报价 26≤cap=26 放行（保守侧），
实扣 10 在预算内，转账语义（数量/路线/描述/交易）不受影响；正式服 worldSize
固定不会出现此分裂。未来 standalone 实验若再建房，应整树重启 engine 进程。

## S05 停止与清理（stop-cleanup/）

见首表「停止与退出」。撤装记录：disarm 前
`{armed:true,attempted:true,attemptedTick:167,syncResult:{ok:true,code:0},
stopped:true}`→后 `{armed:false,…}`（attempted 全保留）。本轮收集器已停
（流定格 975 行）。**未动**：上轮遗留孤儿收集器（PID 131696，`node
tools/console-collector.cjs logs/console-all.jsonl`，经 storage 客户端自动重连
曾订阅本轮 pubsub——纯订阅无写权限无干扰；非本轮进程按纪律不清理，如实记录）。

## 边界与未证明

- 本 PASS 只覆盖当前安装组合与限定正常场景（一次性隔离世界、单笔 100H、无竞争
  writer、无故障注入）；**不等于国库生产 writer 已集成**，不放行正式部署、自动
  重试或其他经济业务；`npm run push`/`local` 未执行。
- PROCESS_STOP_UNCONFIRMED 的工具侧报告由独立 PID/端口复核解决；「工具确认
  回路在自杀式 kill 下不可用」为工具实现特性，非环境故障。
- 实扣费用 10≠报价 26 的 worldSize 分裂为 standalone 特性发现（见上），正式服
  不适用；本轮 cap 绑定与门禁语义未受影响。
