# T1-EXIT-R1 独立最终审查

日期：2026-10-02（Asia/Shanghai）  
评审者：独立 reviewer 子代理；实现、隔离服务操作与本评审分开执行。

**结论：本报告所绑定的冻结产品、发布工具与隔离 A/B4/C2 验收范围，未发现尚未修复的 P1/P2 阻塞。** 此结论允许推进后续发布门禁；不等于已经发布生产，也不等于生产首笔 T1 验收完成。

## 1. 精确身份与范围

| 对象 | 已核实身份 |
| --- | --- |
| 冻结产品源码 | `447ab5c45717ea73af026f60a5c4287080af703f` |
| 冻结源码树 | `a4e59a5fa56461ae1d83f271db38e6fbf69841da` |
| main 大小 | `3,285,061` UTF-8 字节 |
| main SHA-256 | `1bf02d8415f552239dd034865c4e62d5c6a00a978af36f78b64640ea05f6f061` |
| Build tag | `2026.10.2-1+447ab5c@2026-10-02T06:10:35.260Z` |
| 追加前 bundle SHA-256 | `31d7862330a31f620544e07482933253e658806373f42def32ab51f27665c955` |
| 发布工具 SHA-256 | `a3882af6232c8d7a3cb37f7ea0fce06ca9912bb8850abadaf4dd545f97c4f091` |

独立重算了 main、追加前正文及发布工具摘要；检查了内嵌完整 commit/tree/tag 和 `BUILD_DIRTY=false`。`release/manifest.json` 与外部候选 manifest 完全一致。隔离 24 份原始快照中的运行代码大小及摘要全部匹配上述冻结 main。冻结产品之后的部署工具修改不参与 Rollup，工具单独受 manifest 摘要约束；本轮核对未发现其他产品源码漂移。

产品审查重点为 `treasuryT1FirstLiveControl.ts`、`treasuryT1FirstLiveState.ts`、`treasuryT1Responsibility.ts`、`treasuryTerminalTransfer.ts`、`treasuryTaskCommitmentBridge.ts`，并检查 main/resourceControl、arbiter、任务保留与 carrier 的必要接入关系。state 抽取保持原只读解析、签名和 UTF-8 计数行为，bridge 不再依赖控制动作网关。

## 2. 已修复的独立发现

- preparing 写入后、首次内核接纳前 reset 的责任无法交回：现由生命周期使用完整只读证据及精确创建身份安全收尾，纯净 absent 路径不初始化服务或预约迁移。
- 实际 native 后任务经公开 API 取消，再确认 committed 时永久保留 lease/quota：现按原 attempt 和任务创建身份恰扣一次，同时保留 cancelled/failed 等业务状态。
- 同 ID 新任务继承旧承诺排除：现对创建身份、原任务金额、路线、资源及 attempt 作匹配，新业务行不继承旧切片。
- admission 已持久而 quota 尚未持久、租约仍有效的 reset，被 begin sweep 先归档并丢失关联：现先停止原控制，并在所有内核 begin 前依据原 pending/无调用边界证据发布任务侧未执行结论及取消同一 attempt。CPU 或关闭写入失败时保留 pending 证据，下次重试；不从 reserved 或超时推断未执行。
- 未知版本 closing lease 被最终清理入口放行、坏 drained quota 导致原任务关联被清理：已补相应门禁及保留回归。
- 部署工具将 HTTP 200 API 错误或缺 data 当作无责任、遗漏旧责任字段与坏 resourceControl 根：已要求 HTTP 与 `ok===1`、完整 Memory 读回及根校验，并逐项对齐 canonical 17 个旧责任字段。

控制主/镜像坏状态仍拒绝准入；部分控制写入仅在签名旧值与本次自有新值可精确归因时回滚。unknown、配额及两端保护不会被 OFF 或到期清空。默认 OFF 的纯净无责任路径保持惰性。

## 3. 原始隔离证据核实

原件位于 `engine/evidence/`；装夹与驱动脚本位于 `engine/tools/`。环境使用回环隔离 storage `::1:21027` 和独立用户 ID `7dad41a4bfc9d96`，与正式账号 `634fe406347a7b69b28aeccb` 区分。实验设置公开记录了任务、Store、暂停/恢复、控制 arm、故障与合成持货；脚本不制造成功交易或成功 receipt。

评审独立运行 `tools/verify-evidence.py --candidate /Users/forst/Downloads/screeps-t1-exit-r1-candidate-20261002`，验证通过。另将 24 份 `rawMemory` 分别送入冻结产品对应的控制签名/主镜像解析及 kernel health 校验，全部为合法 valid/healthy 或 absent；unknown 快照责任为 held，A/B4/C2 的最终责任为 clear。以下判断来自原始交易、实际对象 Store、任务、quota/kernel/control 与 systemd journal 的交叉核对，不仅依据文件名称或既有 passed 文件。

### A：无责任失联自动交回

`a-armed-no-responsibility-snapshot.json` 显示控制 active、原任务剩余 100、无 quota/core/lease；普通调度被实验设置停用。跨过真实 60 秒截止后，仅排队 `Memory.cfg.resourceControl.enabled=true`，没有操作员 close 或手写 Treasury mode。

`a-expired-ordinary-restored-snapshot.json` 显示控制持久 closed、原因 `control_lease_expired`、有效 OFF，quota/core/lease 仍未创建。真实普通交易 `86c6b452e8c5a87` 在 tick 640 完成原任务 `lab-exit-a-H`，description 为 `resourceControl:task:lab-exit-a-H`，实际发送 100 H、源能量减少 4；任务 done/0，两端 H 差额对应。该 A 实例新增 T1 native 为 0。

### B4：未知责任保护、真实重启与恢复

`b4-before-native` → `b4-real-native` 新增唯一真实 T1 交易 `2e09b65e4c71551`，tick 670，100 H、实际费用 4 energy；description 绑定原 attempt `tk1_1_d5a2434cd5657254`。quota 为 dispatching，内核为 outcome_unknown，任务仍 pending/100，native 前控制已关闭。

故障原件明确把真实已到达的目标 H 从 1100 改为 1101；对应恢复原件只撤回这 +1 H，未改交易、任务余量或内核成功结论。故障期间 OFF 请求经产品恢复为 drain，原 quota/attempt/任务关联保持；两端普通任务保留 pending/100 与 `send_code_-4`，没有同切片补发。无关 W9N8 → W8N8 的真实普通交易 `d19ab758711d9a4` 仍完成。

`engine/service-journal-original.jsonl` 的 systemd `_PID=1` 原始记录证明，2026-10-02 15:18:42（北京时间）在两份相邻 B4 快照之间真实 stopped → started，服务 Invocation ID 改变。重启后仍是同一 unknown attempt，交易集合没有新增。后续保护快照也已跨过该控制的固定 30 分钟墙钟截止。

carrier 实验明确使用合成“已持有 50 energy”与原目标分配装夹，保护期间真实 creep Store 仍持有 50。恢复真实 H 后产品沿原 attempt 提交：任务 done/0、quota 仅改为 drained、kernel active 清空、唯一 committed ring，累计 dispatched/settledCommitted 均为 1、有效 OFF。两端原普通任务随后分别有真实交易完成，carrier 持货变为 0，普通终端物流恢复。该证据覆盖合成既有持货的保护及恢复，不声称自然生产中的完整 spawn/withdraw 链已验收。

### C2：普通两端先行、原成功链及 OFF 重启

普通 W9N8 → E3N59 在 tick 720、W8N8 → E4N58 在 tick 725 分别产生真实交易 `d050bb47b9fb373`、`a72dbb49911ec4f`。其后封存快照中 T1 控制仍 active、原任务 pending/100，未接纳 quota/core。两端冲突在各自普通先行 tick 阻止了 T1 入场；这里没有声称两笔普通交易发生在同一 tick。

后续 tick 730 仅发生一次 T1 真实 100 H / 4 energy，交易 `5096bb4bbf5435c`、attempt `tk1_1_9992ef348b720174`。确认后 done/0、唯一 committed ring、drained、有效 OFF、active 清空。systemd 原件证明 2026-10-02 16:23:09（北京时间）在确认与最终快照之间真实 stopped → started，并更换 Invocation ID；最终内核、控制及 quota 终态保持一致，无新增交易、无重发。

b、b2、b3、c 是保留的校准失败/普通发送实例，不计入 T1 native 验收。A、B4、C2 的案例间隔离任务及状态重置均属实验设置；不作为产品可重新 arm 或生产可清配额的证明。

## 4. 验证与审查边界

独立评审阶段重跑的受影响产品组为 3 套件 / 47 用例，全通过；最后 state 等价抽取及精确产物另外核对。冻结状态实施日志显示组合 19 套件 / 107 回归、双 typecheck 及 build 通过，独立评审核对了日志而没有把它们改称自己的全量重跑。发布工具最终 4 个离线 Node guard 测试由评审独立重跑通过；最后加强后的测试直接断言真实候选 manifest 的工具摘要，而不是在测试中改写该值，评审再次独立运行全通过。真实 600 tick、30 分钟无责任边界及其他坏状态/CPU/Memory 门禁主要由产品入口回归覆盖；A 引擎直接验收的是 60 秒失联交回。

服务结束原件显示隔离 `screeps-treasury-t1.service` inactive，DSH/nginx active。评审未操作这些服务，未运行部署工具的线上 `--check` 或 `--apply`，未执行生产写入。

所审查生产只读原件包括 2026-10-02 13:30:35 与追加的 16:36:18（北京时间）两次点时快照：完整任务分别 35、23 个，row ID 全部匹配，固定 E3N59 → E4N58 的 H 任务均为 0；末次 Memory 为 1,533,778 UTF-8 字节，T1 control/镜像/quota/core 均不存在，仍是旧生产 main `bdfde69f6b79f3b3bd1a3e51d184d58ec4d0c6f25b94ebdc18233c61248d55a2` 与旧 tag。不得据此宣布生产修复已运行、原任务已就绪、首笔 native 已发生、交易已确认、余量已结算或终端已交回。后继 UH 资源/路线建议不属于本冻结 H/E3→E4 权限，本评审不为其业务执行签署。

## 5. 最终判断

源码/产物身份、已修发现、发布工具门禁以及冻结 main 的隔离 A/B4/C2 原始证据范围内，**未见剩余 P1/P2 阻塞**。真实重启的证据出处缺口已由原始 systemd journal 补齐并复核。后续发布必须使用本报告绑定的冻结字节和工具，满足 clean Git 与现场只读前检；任一产品源码、依赖或运行字节改变，应重审受影响范围。生产阶段各门槛仍须单独以实际证据记录。
