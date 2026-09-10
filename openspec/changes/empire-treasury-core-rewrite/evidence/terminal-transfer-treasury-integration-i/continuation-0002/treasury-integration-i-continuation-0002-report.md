# Treasury Terminal Integration I · Continuation 0002 报告（lab-ti1-0002）

日期：2026-09-10 · 执行 Agent：ZCode · 独立验收：subagent（只读判读，
结论见 `independent-acceptance.md`）

**判定：TREASURY_INTEGRATION_PASS** —— 一次真实 `terminal.send()` 调用（tick 536，
同步 OK），100H 经实际生产 facade/kernel 的接纳、占用、观察、注册结算与占用解除
完整闭环，窗口 23/23 完整，及时暂停（触发延迟 5.86ms）与绑定进程树自动确认退出
（7 PID、3245.77ms、auditErrors=[]）。工具 `treasury-verification.json` 原样
返回 `TREASURY_INTEGRATION_PASS`，未修改。

## 三问先行（任务书 §9.1）

1. **是否真正到达一次 `terminal.send()` 调用边界？**
   是，恰好一次。tick 536（=首次固定且未改动的 T）。原始 console 同一信封内
   `lab-send-attempt` 三阶段：pre-call（fee=26）→ boundary → sync-return
   （`{ok:true,code:0}`）；无 sync-throw、无 api-error、无
   precondition-rejection；全文件唯一 attemptId `tk1_1_20faab99a8378f8a`。
   完整参数：`Game.rooms["W1N57"].terminal.send("H", 100, "W10N57",
   "lab-ti1-0002 W1N57 to W10N57 100H")`，终端 `ti20002aa57000001`。
   “3 个事件”是同一调用点的三阶段插桩，不是三次调用（boundary 计数=1）。
2. **是否观察到 100H 到账且经过国库接纳、占用与注册结算？**
   是。536 admitted（phase=pending；committed H=100、energy=26；
   targetRiskAdjustedFree 297900）→ dispatched（phase=outcome_unknown，
   dispatch result=unknown）→ 537 世界已变仍 unknown → reconcile
   `observed_committed/exact_transfer_and_fee` → reconciled（closing/committed，
   占用归零）→ settle `{status:"ok"}` → 538 起 active=[]（退出），
   538–556 全程 healthy。Memory ring closedAtTick=538；counters
   admitted=1/dispatched=1/settledCommitted=1/rearmings=0。唯一交易
   `455da824072e365`（time=536、H/100、W1N57→W10N57、双方同一用户、
   description 精确、双视图各一条且无 order）。
3. **是否及时停止、保留未决事实、自动确认进程退出？**
   是。窗口末端先到（~34.1s，非 180s 超时）；触发延迟 5.86ms；pause OK →
   6 次 pause-state（556→557 稳定）→ stableTick=557；撤装写入并读回
   （armed true→false，attempted/attemptedTick/syncResult 完整保留）；
   `process-stop-result.json`：terminated=true、7 PID 全观察、polls=1、
   auditErrors=[]、elapsedMs=3245.77（<4500 预算）。

## 验证两行（任务书 §4.1）

- **历史全量（继承）**：`838dcc79b33e6e1b76c698afa7cf88be47859091`，246 suites /
  1515 tests，passed=1515、failed/pending/todo/runtimeError 全 0。继承依据：
  `838dcc7..9aa1c48` 差异 225A+2M **全部位于 openspec**（非 openspec 文件数=0），
  自 VALIDATION_HEAD 至交付 HEAD 无运行代码/依赖/构建器/测试语义变化；
  原件见 `../final-validation/jest-full.json`、`budget.stdout.log`、`second-tree/`。
- **本轮定向**：`RUN_VALIDATION_HEAD = cf29a69`，实际执行
  tsc×2（exit 0、零输出）、integration 三套 18/18、LAB 四套 54/54、
  C02 `verify-lab-calibration` 55/55、live bundle 构建 482336B /
  `bfbc5c55…6672`、冻结 diff 零差异、dist/main.js 构建前后 sha256 不变、
  第二树同 SHA integration 18/18 且 bundle 逐字节 IDENTICAL。
  **未声称本轮新 SHA 跑过全仓 1515。**

## 分项结果

### API（Terminal 裸通道）

恰一次调用，tick 536，参数与冻结配置逐字段一致，同步返回 `OK(code 0)`。
调用前 attempted 标记已写入并读回确认（`live_attempted_mark_unconfirmed`
未触发）。调用后世界侧：源 H 1000→900、源 energy 10000→9974（实测费用 26）、
源空位 289000→289126（+126=100+26）、目标 H 0→100、目标 energy 2000 不变、
目标空位 298000→297900（−100）、源冷却 0→546（=536+10）、两端 capacity 恒
300000。

### 国库（Treasury facade/kernel）

零 mock、零直写：全部占用/结算经实际 `createTreasuryService` +
canonical contract + 注册 adapter/reconciler + policy。链路见三问 2。
world-sequence 只在 T+1 精确匹配真实交易与当前世界观察后经既有
`noteObservedWorldChange` 推进一次，非每 tick 无条件 bump。
closing 期间（537）查询不双扣；538 起 active 真正退出、committed=0、
源 spendable 回到实际库存（900/9974）、目标风险调整空位回到实际空位 297900。

### 工具（lab-control / process-scope / 停止链）

preflight（源/清单/活动模块/facts/端点/C02）全过；单 main 装载（sha256 与
manifest 一致、模块集合仅 main）；subscribe→resume 一次；窗口 23/23；
5 秒通道规则未触发（全程有样本）；撤装与终止按承诺执行。
`killConfirmed=false` 是 stop-controller 内部失败路径未触发（该项只在暂停
失败时走），进程终止由外层 `killTree()` 完成并落盘 terminated=true；
stderr 的一行 `Storage connection lost ECONNRESET` 是工具自身连接在 storage
被终止后断开，退出码 0，不是被测系统错误。二者均已如实记录。

## 提交链（全部线性，未 amend/force）

| 提交 | 内容 |
|---|---|
| 58ec3f3 | S01：关闭继承实验开关（enabled=false）+ 任务原件与继承验证索引归档 |
| 4fb23e6 | 准备期绑定：lab-ti1-0002 世界身份（用户/双 Terminal/shard）写入 labConfig+example |
| cf29a69 | **RUN_VALIDATION_HEAD**：T=536 固定、q=26 回填、enabled=true、本轮 facts fixture 与场景 G 配对 |
| f8b3a26 | 证据归档 + 本报告 + 独立验收记录 + 实验关闭默认 enabled=false |
| 03f7170 | **DELIVERY_HEAD**：原始持久化存储副本与终态核对（撤装落盘印证）；环境清理完成 |

- `RUN_VALIDATION_HEAD`（实际启用、构建与实测的 SHA）= `cf29a69`，bundle
  `bfbc5c55…6672`、482336B。
- `DELIVERY_HEAD` = `03f7170`。二者差异：仅证据/状态文档与 `enabled.ts`
  收尾关闭；关闭配置做了对应定向检查（tsc×2 exit 0、integration 18/18），
  **不声称启用产物曾在关闭 SHA 上运行**（启用产物只在 cf29a69 上构建与实测）。

## 环境与就绪依据（任务书 §6）

- 新隔离环境 `D:\code\screeps\lab-ti2-env`（server+world 全新，不复用任何旧世界）；
  安装组合与 lockfile 复用上轮已解析字节（screeps 4.3.0 / engine 4.3.0 /
  driver 5.3.0 / backend 3.3.0 / common 2.16.0 / launcher 4.2.0 /
  pathfinder 0.4.17 / storage 5.1.3；lock sha256 `d95c2c12…`）。
- **restart 策略**：实际安装的 `@screeps/launcher/lib/start.js`（sha256
  `a4d561b9…`）第 117/144/214/223 行显示 `restart_interval` 只传给 runner 与
  processor 且递归重启不再传递；原 `.screepsrc` 3600 → 生效 `86400`（>本轮
  全部周期），最终以运行进程树核对（全部进程同一启动时刻，无更替）。
- 世界：W1N57/W10N57 新建并开放，双 controller level 8 归合成用户
  `lab-ti-user-0002`（id `f6afa65997c093d`），双 Terminal
  `ti20002aa57000001`（1000H+10000E）/`ti20002aa57000002`（0H+2000E）；
  其他 4 名 NPC 均在无关房间（W9N9/W1N1/W1N9/W9N1），交易集合 0。
- **完成屏障（§6.3）**：以真实引擎事件 `roomsDone`（payload=gameTime）与
  `queueDone:usersIvm`/`queueDone:rooms` 为完成依据，非仅 `paused=true`。
  多次核对：observe-false 后（roomsDone 530/531）、observe-armed 后
  （roomsDone 532/533）、T0 复读三次（tick 恒定 533）、装载前与恢复前
  （无 `Main loop reset`、无滚动重启、进程同一启动时刻）。
- 控制往返：inspect（控制槽 absent）→ initialize（armed=false，写入+读回）→
  observe-false 两真实 tick（529/530）→ arm 一次（armed=true，attempted=false）
  → observe-armed 两真实 tick（531/532）→ facts（**T0=533**）。
- 一处环境修正（如实记录）：目标终端初始缺 `storeCapacity`（W10N57 未进入
  activeRooms 集合，引擎 `processor/intents/terminal/tick.js` 仅在房间被处理时
  补该字段），导致 freeCapacity 读数为 null；处理方式为把 W10N57 加入
  activeRooms 并**统一整树重启**让引擎实际处理该房间，之后两端
  storeCapacity=300000、freeCapacity 正常（源 289000/目标 298000）并由本轮
  基线 24 样本逐样本复核。未修改引擎代码或生产 src。

## 费用与容量（任务书 §9.3）

- 冻结报价 q=26（cap=q，本轮基线逐样本实测恒定）；实测源 energy 净减少
  **26**，与报价一致（`reason=exact_transfer_and_fee`）；无 lower-fee 警告。
- 源 H −100、源空位 +126（=100+26）、目标 H +100、目标空位 −100、
  目标 energy 不变、两端 capacity 不变（300000）；全部逐项核对通过。

## 边界声明与遗留

- 未连接线上服务器/PTR/既有私服/真实账号；未执行 `npm run push/local`；
  未合并 main；生产 `src/` 与根配置零改动（冻结 diff 零差异）。
- `enabled.ts` 当前为 true，仅随本 VALIDATION_HEAD 提交、只对装载该 bundle 的
  世界有意义；**不构成任何后续实验授权**。实验 lab-ti1-0002 已关闭
  （控制槽 stopped=true、armed=false、attempted@536 保留）。
- 一次实验授权已消费（一次恢复、一次 send 调用）。不换 ID/T 重试。
- 独立验收的 12 项观察点（字段命名、stderr、保守中间态、标签脱节等）见
  `independent-acceptance.md`，均不改变 PASS，其中"boundary 事件未携带实参"
  与"killConfirmed 命名"建议后续改进。
- 工作区遗留（未入仓库）：`D:\code\screeps\ti2-work`（过程证据，已全部归档）、
  `lab-ti2-env`（隔离环境，进程已 0、端口已 0）、`ti2-second-tree`（第二工作树）、
  `ti2-bundle-live`/`ti2-bundle-second`（构建产物）。
- PASS 仅针对本次限定合成场景，不等于生产上线、并发物流、市场或任意故障
  恢复已通过。
