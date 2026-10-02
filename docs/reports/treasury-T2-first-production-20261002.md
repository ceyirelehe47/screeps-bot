# 国库 T2 首次生产接管候选报告

本轮尚未生产上线。现场核验时原 UH 任务仍 pending1715，但目标 UH2O=2385、已有成品1885、UH原料500，实际 UH 新补料需求为0。按任务包的无真实需求分支，保持现役安全代码，未执行代码上传、arm或Treasury native；没有造任务、手工补货或切到OH。

## 生产事实与停点

本轮正式观察为北京时间2026-10-02 18:03:32至18:20:24.586，shard1 tick74077720→74077960，共240新tick、约17分钟。结束后没有后台观察或继续空等。终态四shard均无新旧Treasury持久责任，线上main仍3,285,061字节、SHA `1bf02d8415f552239dd034865c4e62d5c6a00a978af36f78b64640ea05f6f061`，运行tag `2026.10.2-1+447ab5c@2026-10-02T06:10:35.260Z`。

原 `74073650:1:UH:E4N58->E1N57` 的1715来自整batch2215减原料500的旧跨房规划口径，不代表当前剩余目标的真实缺料。原料实验室500 UH已经覆盖剩余500 UH2O，OH实验室仅3；额外在途覆盖只会进一步降低UH需求，不会制造新需求。细节、未读取项与时点限制见[现场业务诊断](treasury-T2-first-production-evidence-20261002/business/现场业务诊断.md)。

近40条去重交易证实最近15周期E4→E3自动补Energy占用源终端，14周期同时反向capacity relief；Game取证tick74077911源cooldown9。候选最小修复为不向承担健康且有正余量Energy relief出库责任的房间反向补能。候选没有改储备、优先级或市场策略，此修复目前尚未生产生效。

市场permit与receipt链保持连续，hub保护高水位41991→41996，普通业务正常推进。临时shard probe和Game只读结果键的写入/清理有记录，不宣称从未写线上Memory；没有改canonical业务任务、历史额度、库存或旧Memory备份。

## 产品改动

复用同一Treasury facade/kernel、终端gateway和控制生命周期，保留旧H持久编码与消费事实。只新增固定UH E4N58→E1N57 automatic UH2O补料首片：一个既有任务、最多100UH/100Energy费、一次native、600tick/30分钟固定截止、最长60秒控制租约。没有持续自动接纳。

接纳/native共用真实合成剩余目标、生产与市场预约、费用、接收容量和cargo占用校验。只交接100切片，旧任务剩余1615继续承担承诺；unknown不补发、不扣余量，原attempt跨reset恢复。新旧lane未结/坏责任互斥，组合异常只恢复原责任，不开新dispatch。

两端普通send/deal、第三房入库，以及实际carrier、remoteCarrier、remoteMiningCarrier、已持POWER运输、存量Terminal取能和PowerCreep Terminal扩展供能遵守同一Store保护。仅在持有责任期间延后相关Terminal动作，正常Storage与无关房继续；不启用PowerBank/Observer/PowerCreep活动。

## 工程验证

精确lock安装后：38suite、347/347通过，0失败/跳过；11项无网络生产工具反例通过；typecheck/build通过。首次build因复制旧node_modules缺少lock中terser插件失败，随后npm ci对齐依赖锁并重新验证，没有改产品源码或强制升级依赖。过程失败、原始red与隔离副本重建red均单独注明。

构建有循环依赖警告；最终候选的实际main启动、业务、恢复由同字节实机验证确认，不以仅编译成功替代。最终构建及工程身份：

| 项目 | 值 |
| --- | --- |
| 产品commit | `a84275040d4f8f8bfea2135a8465608f97637c22` |
| tree | `08b6f7592451faa6832ea4719c5272ab40cb9199` |
| 构建tag | `2026.10.2-2+a842750@2026-10-02T10:56:13.388Z` |
| main SHA256 | `a33ca56e530060f0e719630324bfe3d55649786ff19525483fd04197d315653f` |
| main字节 | 3308853，单main模块，低于5,000,000 |
| 去尾bundleHash | `4528cc84f0ac0ee82fe74d58d0ff9cf8292acd4e4e803c64d6d0d7412ce7b1b3` |
| lock SHA256 | `7c34b3cab2a00901d3abbe9a1a1aaad9bb4d4a95e19f87793cb21d29a8a06632` |

## 同一最终构建的隔离实机结果

独立隔离账号 `7dad41a4bfc9d96`（lab中显示名forster），官方engine4.3.0。四个独立pre-T2数据库实例保留原H消费事实，采用29个完整状态原件；所有采用场景代码SHA均为 `a33ca56e530060f0e719630324bfe3d55649786ff19525483fd04197d315653f`。没有使用实验main。

| 场景 | 实机结果 |
| --- | --- |
| C1原1715 | attempt `tk1_2_0c04cd2ba07f525c`，真实100UH、费用10Energy；首次结算1615，重复恢复不再扣；普通路径另送1615至done0。两种事务来源分开。 |
| C1正好100 | attempt `tk1_2_f22640028fddd63c`，真实100UH、费用10Energy，done0、drained/OFF；继续恢复不再扣。 |
| C2并发/unknown | 先有两端真实第三房入库；attempt `tk1_2_563d0bd13dd4ea10`真实100UH后目标实货+1矛盾故障保持unknown。OFF/失联/真实service restart保留原责任；无关E3业务推进。只撤实验+1后原attempt结算一次，两端普通动作恢复。 |
| C2持货保护 | 两只合成已持50H的真实carrier在两端延后，解除后各真实交付50H；原连续链另有同unknown私有快照分支补强调用前标量trace。分支不再产生T2 native，不计第二次结算。只证明持货/真实角色执行/解除交付，不证明自然spawn→pickup或heap计划跨reset持久。 |
| C3无责任退出 | 实际失联 `69.303`秒，自动closed/OFF且T2 native0；旧普通100UH真实推进。真实service restart后仍OFF、无新T2，重新arm被already_used拒绝。 |

主任务从原件再次独立运行验证器，exit0；`validation/root-engine-verification.json`不是读取既有passed文件得到。sourceEnergy交回后的其它变化按普通cargo归因，不把尾快照总差当国库费用。lab装夹、未采用校准和driver counter完成差等范围见[引擎说明](treasury-T2-first-production-evidence-20261002/engine/README.md)。最后仅lab服务inactive，dsh/nginx active。

独立最终产品审查已通过，单独绑定产品commit、最终main、依赖锁和原件；结论只覆盖工程/隔离候选。见[独立审查](treasury-T2-first-production-evidence-20261002/independent-product-review.md)。正式首片及长期生产稳定均未验收。

## 唯一后继建议

另立一次有界OH既有任务诊断，核对真实OH缺口、旧规划任务有效性与Energy补能/疏散冲突。本轮没有自动执行该建议，也不复用UH一次性权限改发OH。
