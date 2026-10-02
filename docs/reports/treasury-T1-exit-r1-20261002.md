# Treasury T1 退出修复与候选交付（2026-10-02）

退出缺口已修复，最终冻结字节在真实隔离引擎通过自动交回、未知责任保留及成功并发链。生产仍运行9月27日的旧默认OFF版本，本轮未上传、未arm、未调用生产native。候选实现和验证可交付；下一动作是获得这一份默认OFF安全更新的明确直接授权。

原路线是否有真实业务需求与工程完成分开判断。初次只读覆盖35条完整canonical任务，没有任何H任务，也没有E3N59→E4N58 H任务；E4N58没有当前H合成缺口。本轮没有制造任务、搬货或更换资源来取得首笔发送。末次生产核对与精确版本见证据目录追加记录。

## 已完成的产品行为

每tick生命周期先验证control主/镜像、期限、任务/端点/部署身份及完整责任，不依赖pending任务扫描。60秒失联、600tick或30分钟固定截止停止新增；健康且无责任时持久关闭control并交回OFF，旧resourceControl实际获得执行机会。UTF-8按字节计数，保持1900000安全门槛、剩余CPU至少20、bucket至少2000、真实费用与市场保护。

有quota、原kernel work或task lease时保留精确责任。未发生native且能由持久invocation边界证明的pending work沿原attempt取消/收尾；接纳后还未写quota的reset恢复原attempt身份，不新建第二次额度。已有native/unknown时停止新增并保持drain及两端必要fence，证据充分后原attempt结算一次、drained保留、lease关闭，再交回普通物流。cancelled/failed保留业务状态并完成应有结算。坏control/quota/kernel/lease、坏任务根或关闭持久写失败不当空表；同ID新任务不继承旧许可或承诺排除。

没有修改generated Core、主循环阶段顺序、原run/control ID、市场r7策略/价格/permit/WAL、R2关闭状态。把纯控制解析拆到`treasuryT1FirstLiveState.ts`消除了控制→任务→仲裁器的循环依赖，无新增console全局导出。

## 新验证结果及边界

改前真实产品入口回归失败原件和旧源码反例重放都保留；后者仅证明旧缺口。最终组合运行19个实际套件107项通过，涵盖T1/control/lifecycle/任务桥与kernel路径、resourceControl/容量/预约、arbiter、carrier、市场Direct、main。typecheck与构建通过。开发期3套件47项为中间版本，最终结论以107项组合为准。未用空跑或固定测试数量替代业务验收。

新增产品入口覆盖到期边界/后续tick、空/取消/终结/清理队列、同ID新任务、接纳前/接纳未quota/reserved未调用/native未知/closing reset、坏根/坏quota/未知版本lease、持久写失败、CPU/Memory安全条件、封锁解除后的普通发送正向路径。部署前读取工具另有4项Node测试，HTTP200中的API错误、缺失Memory、坏根、全部17项旧责任与冻结身份误配均拒绝。

最终main在同一官方engine4.3.0、Node22.22.1隔离世界组合运行：

| 场景 | 原始事实 | 产品结果 |
| --- | --- | --- |
| A 无责任失联退出 | 638 arm；调度暂未启用，snapshot无quota/core/lease；真实wall clock超过60秒，仅重新启用旧调度 | control自动closed/OFF；普通原任务真实100H，交易`86c6b452e8c5a87`；T1 native=0，原任务done/0 |
| B4 T1先行、未知及恢复 | 670唯一真实100H，attempt `tk1_1_d5a2434cd5657254`，交易`2e09b65e4c71551`，实际源Energy-4；人为将已到账目标H1100→1101并读回 | OFF/失联/真实进程重启仍保留原quota/work/lease、两端普通入库被拒；无关W9→W8真实100H可执行；carrier合成已携50Energy仍保有 |
| B4 恢复充分证据 | 只将装夹+1H减回1100，无手造receipt/结算 | 原attempt在691 committed，done/0、drained、无active/lease、OFF；随后两端普通入库各100H恢复；同carrier持货50→0，正常补给恢复；T1不重发 |
| C2 普通先行、T1延后 | 720 W9→源端、725 W8→目标端的普通100H先行；726 snapshot仍未准入T1、无quota/core | 730才唯一T1 100H，attempt `tk1_1_9992ef348b720174`，交易`5096bb4bbf5435c`；732 committed；最终done/0、drained/OFF |
| C2 已闭合真实重启 | 同一最终字节真实service restart后推进10tick | 756结束snapshot无新增交易、原drained保留、无active/lease、OFF |

每个隔离案例是新合成任务实例，未把lab重置方法用于正式服；B/C各自一次100H不代表允许生产两次。旧历史交易包含前轮实验，校验按交易ID增量和description/attempt分类。carrier是明示合成的已携货+已有分配计划装夹，未声称本轮实测到此前pickup；后续目标Energy增加500包含其它补給，不能都归给50 cargo。真实故障装夹与真实native原件分开保存。

B/B2/B3/C初次尝试为调度/驱动校准，未发生本次T1或租约已经过期，保留原件但不计验收；包含real-native的文件名不构成发送事实。旧dotted Store修改未落地的问题已用整Store更新及强制读回修正，B4原件才满足矛盾注入。A实际时钟失联由实机证明，其它固定截止由真实产品入口测试证明。隔离服务结束inactive，原dsh/nginx均active；实际重启journal与前后snapshot关联保存在证据目录。

## 冻结身份与独立审查

- 基线：`43b53daa81bdeb9fdafea97c2d4a1ad8936835cc`；产品提交`22516cbf`，纯状态拆分及最终构建源`447ab5c45717ea73af026f60a5c4287080af703f`。
- source tree：`a4e59a5fa56461ae1d83f271db38e6fbf69841da`；版本`2026.10.2-1`；构建时clean，BUILD_DIRTY=false。构建后未重建main。
- 上传模块集合只有`main`，3285061字节，小于十进制5000000；最终文件SHA-256：`1bf02d8415f552239dd034865c4e62d5c6a00a978af36f78b64640ea05f6f061`。
- build tag：`2026.10.2-1+447ab5c@2026-10-02T06:10:35.260Z`；追加前bundle标识：`31d7862330a31f620544e07482933253e658806373f42def32ab51f27665c955`，与最终文件SHA不同。
- 未打包的部署工具经独立审查后修补API成功语义、完整Memory与全部旧责任门禁，摘要`a3882af6232c8d7a3cb37f7ea0fce06ca9912bb8850abadaf4dd545f97c4f091`。此工具/交付文档的后继提交不同于构建源447，manifest明确分开；没有把后继HEAD冒充main构建源。
- origin fetch/push核实为`ceyirelehe47/screeps-bot`。原checkout、其它已存在remote未变，本轮独立worktree及`codex/treasury-t1-exit-r1`分支；只推该新分支，不reset、不强推。

独立reviewer `/root/t1_exit_independent_review`按附包明确要求只读复核精确产品提交、main文件与内嵌身份、部署工具、业务不变量和原始引擎记录。其开发期发现包括接纳未quota恢复、取消收尾丢证明、cancelled确认卡住、同ID承诺排除、未知closing版本/坏drained行清理，以及API错误被当空Memory、遗漏旧责任字段/坏resourceControl根，均已修补并有回归。最终原件签署在`independent-final-review.md`；不把修复者自查当独立放行。独立评审未操作生产或lab。

## 生产需求与明确停点

初次捕获2026-10-02 05:30:35 UTC，完整35任务，Memory业务tick74073886；旧运行tag为`2026.8.29-6+16c2ca4@2026-09-27T06:26:24.112Z`。main3275477字节、SHA`bdfde69f6b79f3b3bd1a3e51d184d58ec4d0c6f25b94ebdc18233c61248d55a2`；实际Memory UTF-8 1548115字节。T1 control/镜像/quota/core均不存在，默认OFF；R2主/镜像closed。当前读回没有给首次writer放行。

| 房间 | Terminal H / Energy | Storage H | 当前生产者与责任 |
| --- | --- | --- | --- |
| E3N59 | 11882 / 20245 | 114658 | resourceControl balanced，没有H入/出任务；库存存在不等于目标真实需求 |
| E4N58 | 0 / 150240 | 4384 | reactions空，synthesis runtime idle，没有显式H demand/missing；resourceControl export，普通接收容量责任remaining=0，已有其它资源/费用承诺 |

`getSynthesisDemandTarget`读取显式demand，`getActiveSynthesisMissing`读取当前合成missing；完整任务与生产者投影没有显示E4需要H。由此可判断当时无该原路线需求，不能推断“永远不会有需求”或仅凭Terminal H=0诊断carrier故障。staging当时主要准入X352、窗口压住14项；没有H任务就没有相应H备货身份，源Storage H不能替代任意新任务的自然备货。其它资源预约、市场费用承诺均在原件，未改储备/优先级。

初次唯一后继建议来自真实既有自动任务`74073650:1:UH:E4N58->E1N57`，created74073650，UH1715，业务用途`synthesis:E1N57:UH2O`；当时源Terminal UH3928，目标普通receiver余量4703。它与固定H/E3→E4权限不同，需新资源/路线适配与直接授权，目标fresh Store/cooldown/费用/占用仍需重新核验。它是初次时点的候选建议，未自动实施，也不视为当前始终就绪。末次读回若它已推进，按新记录标注，不将旧建议复活。

末次只读捕获2026-10-02 08:36:18 UTC，Memory业务tick74076570，完整23任务仍无H/原路线任务，原UH1715任务仍pending，身份/remaining未变。旧main/tag及T1空状态保持，R2仍closed。Memory UTF-8 1533778字节；CPU sample74076569总用54.15、bucket10000、tickLimit500（这是只读时点，不能替代临native实时CPU门禁）。源Terminal H11882/Energy19623、目标H0/Energy27884，两房Storage H分别114658/4384；E4 reactions空/idle。后继建议仍仅这一UH任务：当时源实货3928、目标UH0，末次两端Store/owner/cooldown及预约已补完整；它尚未推进，不把长期pending或单次库存观察当作T1就绪，仍需额外授权和重新核验费用/容量/市场责任。

生产阶段分层结论：实现通过、真实入口回归通过、最终main隔离验证通过；本轮默认OFF修复尚未正式部署；原任务未就绪；生产native=0、生产唯一交易/业务扣减/责任交回均未发生，不能宣称首笔writer验收完成。

`deploy-frozen-t1-exit-r1.mjs --check`为只读，校验干净后继HEAD、447祖先/非文档代码差异、工具自摘要、全模块、账号、旧main、四shard完整Memory及无T1责任、主shard标签/Memory/完整任务。`--apply`需要明确发布授权，只发送本冻结字节，先wx备份，单次POST后独立GET，不重试未知POST；不arm、不发送业务。授权前未执行--apply。末次只读--check在干净交付提交`374be97bcdc19e979c9e0cbd1c583d95ffd670ae`通过：四shard完整Memory均无T1责任，主shard23条完整任务、Memory UTF-8 1533215字节，候选/旧线上字节、账号、源码、工具及全部门禁匹配；记录在`release-readonly-check.json`，只读检查不是部署。

## 结束状态与唯一下一动作

lab最终control closed、mode OFF、quota drained、active为空、无task lease、无新窗口；隔离服务停止，原服务存活。不需继续lab对账。正式服未新增T1状态、任务、窗口或定时观察。旧产品生产状态仍以末次只读捕获为准。

下一动作：用户明确批准对正式 `screeps.com/default/shard1/forster` 发布这一份默认OFF修复。业务无原任务时保持OFF结束，不arm。权限依据见原始`input/AGENT-RUN.md`：“本包本身不授予生产写权限。AUTHORIZATION.txt 是用户直接消息的模板。” 用户“开始吧”已用于完成工程与独立隔离验收，没有将附件模板当作生产写许可。

可复核材料、完整任务、真实Store/交易、独立评审、命令和原件推导校验器均在同名证据目录；发行ZIP附本main、manifest、补丁和无凭据的证据。私有正式全Memory/code备份留在本机，不推仓库或公开包。
