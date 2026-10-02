# T2 产品与最终隔离候选独立审查

审查日期：2026-10-02（Asia/Shanghai）。审查者：独立子代理 `product_review`。

**结论：本报告绑定的工程实现、产品回归与同一最终 main 的 C1/C2/C3 隔离候选通过，本范围没有剩余阻断项。正式业务门仍关闭：现场真实 UH 新补料需求为 0；没有本轮生产代码上传、Treasury arm 或 Treasury native。本签署不代表已上线、生产就绪或首次生产接管通过。**

审查者没有修改产品代码或测试，没有提交代码，没有操作生产账号；进行了源文件审查、本地原件复算，并写入本审查及独立复算文件。附件仅作为规格与验收材料，授权范围依据本轮用户直接请求及主任务明确的有限说明。

## 精确签署身份

| 项目 | 独立核验结果 |
| --- | --- |
| source commit | `a84275040d4f8f8bfea2135a8465608f97637c22` |
| source tree | `08b6f7592451faa6832ea4719c5272ab40cb9199` |
| main SHA-256 | `a33ca56e530060f0e719630324bfe3d55649786ff19525483fd04197d315653f` |
| main 字节数 | `3308853` |
| build tag | `2026.10.2-2+a842750@2026-10-02T10:56:13.388Z` |
| deploy bundle hash | `4528cc84f0ac0ee82fe74d58d0ff9cf8292acd4e4e803c64d6d0d7412ce7b1b3` |
| package-lock SHA-256 | `7c34b3cab2a00901d3abbe9a1a1aaad9bb4d4a95e19f87793cb21d29a8a06632` |
| 部署工具 SHA-256 | `741e9805323d8076d7134e7d757994b8f9aa934f94949621917b6ac825a028c4` |

自行重算了 main、末尾 bundle hash 与去尾载荷 SHA；核对嵌入的 commit/tree/tag/dirty=false、锁文件与部署工具 SHA。`main.ts`、Treasury facade 和 Core kernel 相对该提交父代没有改动。当前运行源码与冻结提交一致。详见 `independent-product-metadata.json`；签署后任何运行字节、依赖或语义变化均不继承本结论。

精确锁文件重新安装后的最终组合为 **38 个 suite、347/347 通过，0 失败、0 跳过**；typecheck 与 build 通过。首轮缺少锁内 terser 插件的 build 失败没有被计作通过。最终 build 明确为 Build only；循环依赖警告仍存在，采用的最终 main 已通过下述真实隔离启动及业务路径。原件位于 `tests/locked-final-combination.json`、`tests/typecheck-locked-final.txt`、`tests/build-final.txt`。

## 产品语义审查

- T2 公开适配固定为 UH、E4N58→E1N57、automatic、`synthesis:E1N57:UH2O`。绑定 canonical task ID、创建 tick、总量、接管余量、两端实体、owner、部署身份；数量取 min(100,余量)，费用不超过 100 Energy。600 tick、30 分钟、60 秒失联边界不能通过 heartbeat 或改名延长。
- T1 原 H 编码、run/control/quota/work-key 仍可辨认；新 UH 编码不能解释为 H。旧额度、旧未结/损坏责任不能由新活动绕过。正式 adapter 共用一份覆盖两条固定 lane 的 policy，避免单槽注册使旧 H 失效。
- 共享任务承诺只排除接管的 100；其余 1615 与相应费用、接收容量仍保留。生产预约、市场暴露、carrier 占用及当前 receiver ledger 在 arm、接纳和 native 前重新核验；Terminal 真实所有权与房间总量采用保守交集。
- 接纳后始终保留原 attempt。quota/lease 短暂写失败保留 pending；单 lane 与双 lane 均先发布原 quota 和 task-side 未执行事实，再允许 kernel 清理。双 lane 漂移只停止新增 dispatch，已有可证责任仍可对账收尾，不能互相无限等待。
- native 前持久封住额度并读回控制关闭；OK 只进入待证。非法返回、throw、缺失/重复/矛盾交易和 Store 扰动保持 unknown；不重发、不扣业务余量。确认依赖同 attempt 的唯一真实交易与两端资源/费用及容量事实，恰扣一次；取消/失败业务状态仍保留。
- 旧根未知版本、未知字段和坏表不当空；控制镜像、quota、kernel、lease、任务根损坏与关闭写失败均拒绝误交回。fence 缓存只复用同 tick 的全表责任扫描，控制/镜像/quota/旧根的小表健康每次检查，官方发布和 lease revision 同 tick 立即失效。
- 合成需求闸复用当前正式 `runSynthesisControl` 使用的配置 reaction 计划与实货/在途覆盖。它不把未接入正式生产者的未知 autoPlan 当作授权来源。

## Terminal Store 写点已收敛

全 `src`（含 legacy JS、排除测试）的 native 与动态调用搜索已完成。以下现役合法路径均保护新真实端点，并记录普通动作先行的同 tick 效果；成功、异常和非法结果的可能效果都会阻止随后接管。

| 路径 | 实际覆盖 |
| --- | --- |
| marketActionArbiter | 普通/Prepared Direct deal、唯一 terminal.send gateway；第三房 destination 同样检查 |
| carrier | Terminal 取能、合成取料、存量取货、统一交付 |
| remoteCarrier / flagHauling | Terminal 取/交；flagHauling 只生产该 role，没有额外 native |
| remoteMiningCarrier | Storage 满时的 Terminal fallback 交付 |
| powerBankHauler | 已持 POWER 的 Terminal 交付 |
| energyTargets | 既有 Terminal pickup reservation 的实际 withdraw；正常选择策略未改变 |
| PowerCreep | operate_extension 的 Terminal fallback；该能力会使用目标 Terminal 的 Energy（[官方说明](https://docs.screeps.com/power.html)） |

共享 cargo guard 在动作前返回 ERR_BUSY 时保留原货物、计划和 PowerCreep task；解除后沿原动作继续。Storage 与旧 E3N59 的合法业务有正向回归。upgrader、remoteWorker、miner 的正常源/目标仅 link/container/storage/drop；PowerCreep deposit_ops 仅 Storage。没有发现其它可达 Terminal Store native 写点。此结论覆盖现役代码，不能推及未经审查的新角色或外部世界效果。

## 同一最终字节的隔离原件

独立重跑当前验证器 exit 0，采用 **29 个最终 snapshot**；没有读取派生 passed 作为证明。验证器 SHA 为 `a186672229456771f042deaaf5d97e00f61157c245c28e87a99f6ae6390ff441`。`independent-engine-recalculation.json` 保存输入 SHA、实例、环境、真实 driver、交易及 Store 复算。

所有采用状态均为上述 main SHA。实验账号 `7dad41a4bfc9d96` 与正式账号不同；官方 engine 4.3.0/common 2.16.0/Node 22.22.1，回环端口与服务工作目录原件齐备。独立用例从明确冻结的 pre-T2 DB 副本启动，保留旧 H 已闭合/已消费事实，不以清额度重新启用同一活动。结束时实验服务 inactive，dsh/nginx 仍 active。

| 验收 | 原件结论 |
| --- | --- |
| C1：1715 | 采用 `c1-1715-r4`。tick760 唯一交易 `836ac56c2b64fb6`，原 attempt `tk1_2_0c04cd2ba07f525c`，真实发送 100 UH、费用 10 Energy；首次结算余量 1615，后续真实推进不再扣；普通路径 tick770 交易 `2041c570ef29e4d` 发送其余 1615，任务归零。只有首 100 计为 Treasury。 |
| C1：100 | 交易 `fc7cc58b31d1b34` / attempt `tk1_2_f22640028fddd63c`，100 UH、费用 10；任务 100→0、done，quota drained、lease 消失；后续推进不重发/重扣。 |
| C2 主连续链 | 新两端各有第三房真实入库先行；正常 budget=2 保留原 UH 任务，未暂停/取消它。T2 唯一交易 `ea82c5ad9941756` / attempt `tk1_2_563d0bd13dd4ea10`。实际目标 UH+1 故障读回为 101；OFF、失联与真实进程重启仍保留原 attempt/quota/task/fence，无关 E3 普通业务真实继续。撤去实验故障后原 attempt 恰结一次；两端普通入库交回并完成。 |
| C2 carrier 补强 | 原连续链真实持货/解除后两 Terminal 各 H+50 已有原件。额外从该 unknown 私有 DB 分支补充调用前标量 trace：两只真实 carrier 在 main 委托的原 `.work` 中以 ready/working、无 yield、既定 Terminal 目标运行，持 H50；解除后 H50→0、原目的地增加50。分支保留同原 transaction/attempt，未新增 Treasury native；不冒充主链连续运行。 |
| C3 | 真实失联 69.303 秒，无 operator close 或 Treasury mode 手写关闭；自动 closed/OFF，普通路径交易 `55acc645cbab976` 发送100，Treasury native=0。真实重启后不重发；同身份 arm 明确返回 `already_used_or_unsettled`。 |

C2 的 H 实货装到10000以满足默认保护水位，未降低 reserve。carrier 是明确的合成已持货装夹；reset 后显式重建堆内计划，不能声称计划自然持久化，也不能声称自然 spawn→pickup 全链。旧 H 实机 closed/drained 事实保留，旧 H unknown 恢复由本轮产品组合回归证明，未将其冒充新实机 unknown 用例。

暂停标记与正在完成的 Room tick 会造成 driver counter 与后采物理 snapshot 相差至多 1 tick；复算仅允许这个有原件依据的有界完成差，仍检查真实推进增量、UTC 顺序、唯一交易/invocation 与严格 native Store 等式。责任解除后普通 cargo 会继续改变 Energy，未把后续总差错误记为 Treasury 费用。

`c1-1715` / r2 / r3 的校准、失败和首次 partial-download 原件保留，但未采用为通过证据。工具独立审查继承 `tools/review.md` 中精确身份和 11 项无网络测试；本报告不重复将工具测试算作产品或生产成交。

## 正式业务停点与签署局限

再次本地复算业务原件：tick74077911，UH2O target2385、成品1885，目标欠量500；UH lab已500，**UHMissing=0**。原 pending1715 来自整 batch 规划口径，不能据此发送首片。正式观察终态的代码身份保持现役版本，未出现 Treasury 控制或责任；诊断临时 marker 有清理读回，不能记为业务 writer 接管。

本次产品保护和隔离结果不能替代将来新鲜真实需求、生产 CPU/Memory/市场/预约/在途与端点重检，也不能授权换成 OH、其它路线、任意额度或手工 send/deal。当前应交付可复核候选并保留现役 OFF；不为不存在的 UH 需求重复纯 OFF 发布。没有签署“首次生产接管通过”。
