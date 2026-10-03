# 国库 T4 接续、逻辑修复与底层优化

## 当前范围

接续聊天「推进国库系统上线」（`01a0fc97-c46c-7443-af14-92a6200ee706`）。原工作树已不存在，已从确切 Git 提交 `f1016300282d1184df345d85cd864a7523a0e930` 恢复到独立分支 `codex/treasury-t4-architecture`。本轮代码修复、底层优化、服务器回归及当前字节完整隔离 C1/C2/C3/C4 已完成。正式服缺少真实目标需求，保持 OFF，未上传或执行国库业务写入；生产验收尚未完成。

工作树：`/Users/forst/.codex/worktrees/treasury-t4-architecture/screeps`。构建、测试、数据库语义核验与实机压力验证全部在 `dsh` 隔离目录执行，本机仅编辑、轻量查询与文件传输。

## 已完成的代码改动

1. 停止流程先进入 `drain`。任务表无法读取时保持 `stopping`，不再把损坏任务表当作空表完成停止；只有完整确认原责任已清才转为 `off`。
2. 完整证明并深冻结的消费历史可复用成功数学证明。缓存身份包括全部九项政策及三个锚点，每份历史最多四项；当前时间、发送间隔、金额、费用与当前窗口额度仍逐次检查。没有剪裁消费历史，也没有改变持久 schema 或签名。
3. 旧 T1/T2/T3 的围栏读取使用独立接口，完整读取当前描述符、标量、主镜像字节后，只复用同一完整输入的成功签名与数学证明。原对象保持可变，返回独立只读副本；原 native 读取和派发授权路径保留即时校验。序列化钩子与超长异常字段在构造缓存键前拒绝。
4. 完整账本 token 的成功数学证明跨 `Game/Memory` 归属复用，最多保留四个完整输入，失败和异常不缓存。该验证调用链不依赖当前世界或时钟；读取入口仍逐次检查新数据树与主镜像字节，当前归属的时钟、部署、quota、fence 与派发权限由各自 owner 即时检查。新增同归属异常恢复、跨归属坏态和真实 native 零调用测试。

代码提交：`9fb64f2e37266f749b09737e66af445ba415b827`、`53bb7e705343fc9961a3a3e3b8a85a3faebe92a7`、`a24f2a777c26c4f3e3dc2ea489b65d39cab92042`。当前代码版本 `2026.10.3-6`。

## 验证证据与版本边界

| 版本 | 证据 | 结论 |
|---|---|---|
| R5 / `f1016300` / main `214feae…` | 原自然 C1 四笔 `10/10/6/10`，真实冷重启与 5 tick 无重发；新增独验与 36 项工具自查 | 完整隔离 C1 PASS；不认证后续字节或生产 |
| R6 / `9fb64f2e` / main `f6d62d7…` | 旧版停止测试 6/6 失败；修复版 53 套件、654 用例、22 项工具测试、双类型检查与构建 | 全部通过，无跳过 |
| R6 | 合法 90 条消费、128 个准备序号的相同输入纯预算微测 | 暖验证约 20.7 倍、预算查询约 10 倍；只属于函数微测 |
| R6 | 空账本与满历史空闲实机独验 | PASS |
| R6 | 满历史双搬运者、100 次完整查询，1 cold + 30 warm | 完整 C4 FAIL：bucket `9713→9654`；不以均值达标替代 bucket 门 |
| R6 | 损坏任务表停止、真实冷重启、恢复原任务表 | 独验 PASS；只证明停止边界，使用明确合成 exactpilot |
| R7 / `53bb7e70` / main `3fc244c…` | 54 套件、688 用例、22 项工具测试、双类型检查与构建；34 项新缓存测试 | 服务器全 PASS、无跳过 |
| R7 | 三世界完整 C4，各 1 cold + 30 warm；两搬运者与 100 查询全部保留 | 独验 FAIL：满历史空闲一帧 wrapped `104.283279`，搬运查询一帧 `118.293092`，均超过 100 门 |
| R8 / `a24f2a77` | 双类型检查、54 套件、692 用例、22 项工具测试、构建与关键源字节比对 | 全 PASS，无失败、跳过或待办 |
| R8 / R18 | 三世界完整 C4，各 1 cold + 30 warm；90 消费、128 证书、两原搬运者及 100 查询负载保持 | 完整独验 PASS，三个场景全通过、零跳过；只属于隔离 Game CPU |
| R8 / R18 C1 | 正常 producer 的首任务 26、后续任务 10；四次真实 native 为 10/10/6/10、seq 1/2/3/4；释放后真冷重启及五个 actual main | 完整强独验 PASS，OH36、fee energy4、nativeCalls4，无第五笔 |
| R8 / R18 C2 | 一次真实 OH10 / fee1，unknown 真冷重启、OFF hold、责任证据恢复后唯一 commit、停止与普通任务交还 | 完整强独验 PASS，永久扣减仅一次、旧历史保持 |
| R8 / R18 C3-budget | 一次真实 OH10 后原完整 60 tick 观察；停止冷重启、重新启用与普通任务交还 | 子场景强独验 PASS，无第二 native、永久预算不返还、重新启用拒绝 |
| R8 / R18 C3-lease | 准备态等待真实墙钟过期，制造无需求后关闭，普通任务交还与停止冷重启 | 子场景强独验 PASS，T4 native 与消费均为零、closed1 |
| R8 / R18 C3-producerBudget | 正常 producer 首任务26、三笔真实10/10/6；完整60帧预算观察、停止与普通OH10交还 | 子场景强独验 PASS；零执行证书不计消费，预算耗尽未新增 canonical OH 任务 |
| R8 / R18 完整 C3 | 原主入口不指定 scenario，分别重新读取 budget / lease / producerBudget 三个独立世界的全部原件 | 完整主合同实际 exit0 / PASS，非子报告拼接 |

R6 满历史场景中，100 次查询每 tick 仍对旧控制记录做 600 次重复验签，查询段平均约 31.807 CPU。采样后还存在读取 RawMemory、整理诊断数据与写样本的尾开销；这些成本实际影响 bucket，完整门槛保留。R7 优化针对该查询路径，不降低历史、查询或搬运者数量。

R7 测试实际确认：100 次公开围栏查询只完成三个不同旧控制输入的数学验签；同量原 native 读取仍完成 600 次验签。服务器独立比较原 native `readControl` 函数源码与 R6 完全一致。R7 冻结 main SHA 为 `3fc244cdce34b7717b6496e1fc29c9d232100bf33091ee2631a2f7cfa4091838`，manifest SHA 为 `941c0a14c398d5992ea9a034f53d2cf121aef1f44ec5a9c51fc678a00a6018bb`。

R7 实际满历史搬运查询段均值降至 `19.580537` CPU，测量后补计 100 查询的均值 `79.636559`，bucket `9783→9990`；仍不能抵消任一暖帧 wrapped 超过 100 的失败。失败帧、全部 31 帧及失败最终数据库原件保留，未裁剪样本、降低门槛或重跑已消费世界。

R7 完整独验报告 SHA 为 `399964e3eaaa3744aa8be54faa4df1846447880fbbe516a7725e5fd9ee447168`。结束时实验 unit 已停止、PID 为零、三个回环端口拒绝连接；停态回执 SHA 为 `aa046aae1fa1fe16b87e7f28b9c4251b9d2c20b082d2b30a0b355e2d2e264664`。实机失败不阻止继续源码回归，也不授予上线资格。

R8 服务器冻结时确认，完整纯校验函数、`readStatePair` 至文件末（包含 Memory 上限、写入与时钟观察）、七个关键源文件及旧 native `readControl` 都与 R7 逐字一致。账本缓存组实际 30 项、旧围栏缓存组 34 项均通过；新版改动不把缓存数学证明当作动态派发权限。

R8 当前冻结 main 为 3,443,761 字节，SHA `9d300172be0bed439e93b7a47d206dcfa3fc5b9db727a571f8ffa761a14f7f4d`；manifest SHA `6b2b73e71b4ede5f912cfbe14f52ee8c8cc8f803f4af5dacf3602ed31c4e97a9`；源码归档 SHA `d12ebc7360965c22e5092630bc15946230be475fd6f4413ce9e0fb6175729f79`。部署 tag 为 `2026.10.3-6+a24f2a7@2026-10-02T23:59:33.645Z`；源码验证报告 SHA `8364b9720eb63363ed3580024573a2830819539baea4c9f06c962365afa13a83`。后续 Engine 与上线门须全部绑定这组确切字节。

R18 完整 C4 独验报告 SHA 为 `0465efc1e82f1e057274982a5643af499710f66ef348ee9cba728b765bf6cb4c`，明确为同字节、完整三个不同场景的全部 PASS。满历史空闲的暖态 wrapper 峰值 `80.207`；满历史搬运查询暖态 wrapper 均值 `51.388`、峰值 `81.294`，完整查询后均值 `74.369909`、峰值 `96.731289`，30 帧均不超过 CPU.limit 100，bucket `9821→10000`。双原搬运者和 100 次查询在每个暖 tick 执行；冷帧也记录了 100 次 benchmark 查询（24.878325 CPU、完整采样末 272.711103），wrapper 未观测冷帧双 work，不能据此宣称冷帧没有查询。两原搬运者初始各 50 H 真实交接，后续空货 work 不称为持续搬运。90 条消费与 128 份证书是明确合成历史，真实 T4 native 增量为零，旧 37 条交易均保留。

冷帧按原 tickLimit 500 判定，满历史空闲冷 main `104.131`、搬运查询冷 main `116.995`；不能写成冷暖均低于 100。原 headroom 门为逐帧 `tickLimit 500 − usedAfterBenchmark ≥ 20`。按 CPU.limit 100 另算，满历史搬运查询的暖态平均余量为 `25.630091`，单帧最小余量为 `3.268711`，未声称每帧都有 20 余量。本组不证明正式 shard1 的 CPU 预算。结束停态回执 SHA 为 `2970319fdf487d6195c786c63343b9de540bb0517fe0e17a37c0019a64acd706`。

R6 / `9fb64f2e` 的独立停止故障世界在环境 tick `804→806` 中取得最新实际主循环 tick `805` 与同 tick 的签名观察。它证明至少一帧真实冷恢复后的 `stopping/drain`，未取得完整逐 tick history，不外推缺失帧。恢复原任务表后才 `off`，T4 财政动作增量为零，旧九项历史、37 条交易及 OH 守恒均独验通过。此处 805 不属于 R18 当前 C1 准备世界。

## 原验收工具合同修复记录

本节按发生顺序保留工具失败、诊断与后续修复。阶段性待验状态只描述当时进度；最终结论以顶部证据表及本节末尾的完整主合同结果为准。源码在全部 R18 验收期间保持 `a24f2a77`。

R18 当前字节完整 C1 已通过：主报告 SHA `7fef372bff20008f489e3f6e91c66404c8d44fe927370f316c8a0366cd5de7eb`，成套 adapter provenance SHA `b7389f37eeb10209ac17be0ac4a9b6f9d5b7154837ae3d9223422f4deaef7fc3`。原 adapter 43 项和新增 phase 9 项服务器自检全部通过、零跳过。实际 native main tick 为 `815/865/915/970`，对应暂停快照 env tick 各大一，不混用。正常 producer 的首任务 `810:1` 完成 26，后续 `965:1` 完成 10，永久预算累计 OH36、fee energy4、nativeCalls4；释放后冷读回完整 Memory/code/transactions/owned Stores 相等，再五次实际 main 至 991，无第五笔。

本次首次输入检查拒绝基线中两只 carrier 各 50 Energy。保留同一 claim、failed803、drained805 与所有失败 DB，原 main 真实交付 Energy100；原已有合成策略另执行一次 UH5+OH5→UH2O5，新独立只读证明按官方 Engine 常量与 processor、实际三个 Lab 和冷却及累计计数确认精确转换。全 144 原行检查，其它实体和非 Energy 资源逐项保持、旧财政/任务/cfg/37 条交易均不变，tickRate1500 未改。该准备证明 PASS 后才首次 setup，没有复位、删除 claim、清 cargo 或重播排空。

原强独验第一次缺固定 SHA 的历史形状来源文件，补回原字节后第二次把同 tick805 的 preSetup 误作已安装 fixture。两个失败保持；新增命名 wrapper 只依据三个固定路径/SHA、与首次 setup.before 的完整 Memory/code/tx/Store 同一性识别准备阶段。setup.after 及其后所有原快照仍核对完整历史 cancelled task JSON，原 source/history/bundle 数组全量保留。C1 主计划和原 adapter 未修改，C2/C3 均逐项单独执行与独验，不由 C1 PASS 外推。

原 C1 核验器把 schema 2 错按 `state-v1` 签名域核对，并把已备料的控制 `active` 误作已发行 native 权限。新增命名工具只修复这两处合同：按 schema 使用唯一对应域；允许实体备料、预算和零 quota/debit/receipt/kernel 责任证明齐全的 `active`。原工具、原失败结果及原世界不修改，不接受双域 fallback。

四个 fresh C2/C3 的命名准备工具现已完成双重静态审查。各自只从冻结基线 801 创建独立世界：对齐后若原 cargo 已为零，只读观察十秒；若两只仍各持 Energy50，由原 main 自然交付，最多八个实际 main。准备证明绑定原源码与官方反应 processor，区分有限 warmup 端点证据和 driver 全量 raw 行，逐实体锁住 Energy、三个 Lab 的物种与冷却起终端值；不把跨 getter 的中间行冒充全局原子快照。原 37 条交易全字段和旧 11 项财政子树保持；无清货、改策略或补造任务。

原 driver 散列完整 transaction 原文，不能用字段投影替代；入口拒绝重复或未知参数，防止检查与执行读取不同计划。首封纯准备 proof `bfd52e84…` / outer `08a79cdf…` 的六工具服务器语法与 hash 核验通过，但算法自检为 29/31（零跳过）：29 项负例均拒绝，两项正例因工具把 warmup 错套成一次 cargo 下降而失败。失败报告 SHA 为 `b260c371499386780279fde24f54a992fd5fcf4ee0ebe15ac175daf593022b67`，未创建新 case claim，实验服务保持停止。

原完整端点诊断显示，801→803 两只仍各持 Energy50，各房 Terminal −50、Storage +50；803→805 两只 cargo 才各归零、Storage 再各 +50。其它 owned Energy 逐实体保持，合计守恒。首封工具和失败原件保留，新命名工具只修正预热的有限端点模型；803→805 的完整原行及原门保持。801→803 缺少逐 tick raw/native 方法轨迹，不能把端点与源码相容证明称为完整逐 tick 操作回执。

修正版 proof R3 `3248f179053074df105478d6d4a1779c9e6ef9b544523607d14a27277b59e5c6`、outer R2 `b91811c2a1ea090125ff7fd2cdaa6599f0308607ea3c1fab7f61ac8e70d25a32` 完成双重静态审查。只允许 align0 / align50 两个固定端点分支，完整总差按两段相加后再次直接逐实体核对；三份实际 a24 角色源码全文绑定。新自检的零货正例只在明确的算法副本中调整四个能量字段，不修改任何真实原件或未来 case 输入。

服务器新五件语法及 hash 核验通过，新算法自检 31/31 全 PASS、零跳过、exit0：报告 SHA `cb569f8c43f72104b30752b0d47da5d49309a531a35beac1f10ab5cf40a0129a`，明确的算法输入副本 SHA `da45cb963108f3a20309442a2090663b2190fc0e4d0e1abdff7efe25c3892b41`。2026-10-03 03:46:17 UTC 首次启动 C2；当时三个 C3 尚未启动，后续结果分别记录如下。

C2 执行实际 exit0，03:51:04 UTC 正面停态确认 PID0 / 三端口拒绝。第一次强独验的负例构造试图原地修改 frozen dataclass `Snapshot.path`，在主核验前失败，报告 `0785560a…` 与 log 保留。新命名 outer R3 `5f6628ddefb204be5eaaefafcf1e19324e0c8fa22b317d7424c33ac13d607531` 只改为 `dataclasses.replace` 构造反例副本并更新入口名，原门、依赖和世界均保持，双重静态审查后只读重独验，没有重演 C2。

C2 使用明确合成 exactpilot 的隔离输入，完整强独验实际 PASS / exit0：主报告 SHA `17f42a74753f02e1b58fd2cdeb0da9b3f296387daf9b738e19366b0b5c880ff0`，成套 provenance `fdc3a19664781f49eefacb28c01d99508b4402644bc9dea7b07c38338b82f165`，独立准备/物理/冷重启/负例核验 `6f9c82f966b761a2bbffcb365f7a16aa1ed18c4138b9e4bf88a6b35664db6437`。唯一真实 native OH10 / fee1 只产生一份永久 debit；unknown、冷恢复与 OFF hold 不重发、不退款，恢复证据后唯一 commit，remaining903。停止、重复关闭及四个相关普通任务完成交还均通过，旧完整历史保持。随后分别执行三个独立 C3 场景。

C3-budget 完整强独验实际 PASS / exit0：主报告 SHA `b8ccab6f1330ab75fca144456069cdbcb33b8e3bb5f91a425f4632620bb7c9f6`，成套 provenance `7619d075ab052b887352a9da02438bc67bed1c34aa1b27eab3bcd0e83cc1af93`，独立准备核验 `75cf39ecefb458dcfb7bd0220558e7eb1a8c9b7699897f6c9c5f0d1a1d5e7336`。一笔真实 OH10 后，原完整 60 tick 无第二笔 T4 native，remaining903 / consumption1 / closed1 保持；停止后的真实冷重启不返预算，普通任务交还，重新启用仍拒绝并保持 stopped/off。04:06:29 UTC 正面停态 PID0 / 三端口拒绝，回执 `8376c03a731bc246a3e13c89f1fc23bd34855d6f7b2c65520e8b3e53b585dc26`。

C3-lease 子场景强独验实际 PASS / exit0：主报告 SHA `d6a5a6805260cedaff0454f0b3559dcdb092137a28784c54ead5bacb7dca463a`，provenance `8e9b114657e613f597479dbf25c19b5b0662d7eca46017d5cfc4ca12e8c8a216`，准备核验 `24599e73bf7e0cffa04aa9a622a52d7d0be314afc55c613c951c99e2f9cb66ec`。准备态无 quota / reserved fee / task lease / Core active，按真实墙钟等到原 leaseUntil +3 秒；随后只在隔离输入中把原 goal30 降为4制造无需求，原 main 关闭并交还普通 H。全程零真实 T4 native、consumption0 / closed1，停止冷重启后仍零重发。04:14:23 UTC 正面停态回执 `22079a95d30d933621b7bce6ffbfb69758c7c9fd1e20207a50319f389672bd71`。producerBudget 与原完整 C3 成套合同仍待执行，不以两个子场景 PASS 外推完整 C3。

C3-producerBudget 首次脚本在 04:27:07 UTC 安全停止并保留失败：回执 `fda3bb6b6caf1f54538b2ed20e7a25e1e2850983831afc157fe08bd2314b9d62`，最终 DB `f2ff18ad46edc135eb103339b8e8d00aa306de54fdc3fc4fd23274249f018e9d`。此前真实三笔 `10/10/6` 合计 OH26、nativeCalls3，首 canonical 任务 `805:1` 的26已完成且接受一次；closed4 中 seq2 为签名 `not_executed/pre_native_recovery` 零 native 证书，不算第四次消费。

失败是原 batch 安全门发现目标 carrier 仍携带刚合成的 UH2O30：实际 tick931 的接收房结构内 UH10 / OH0 / product0，加 cargo 后 product30，SC 正处于 `unloading`，successfulRuns6。goal40 已设置，batch 三字段尚未写入。首版同 claim 续行工具要求原 main 自然交付产品至固定 Storage，再第一次执行原 batch；这个接收端假设后来被实际证据纠正。有限卸货最多八个实际 main，保留全 raw 和十秒末端稳定证据，核旧40条交易、消费26/closed4、任务与配置保持；Energy 只核完整端点总量，不强求零 Energy cargo。零 UH/OH/UH2O cargo 门、库存、消费与原步骤不变。

新执行链完成双静态审查，服务器语法/hash 与 20/20 算法自检实际 PASS、零跳过，自检报告 `2ff131d40618dce96db63120b1b09a8c86495338ea5bd96fc6c791bac2f01534`。05:14:48 UTC 正面停态且前后 workingDB `f2ff18ad…` 字节、原 claim 均不变，随后首次启动同 claim 续行。driver `8d607fa5…` / proof `776b9b76…` / caller `d0b43c97…` / supervisor `b771ad43…` 只重启原数据库及未执行的原尾部，caller 不直接 OS stop，由 supervisor 在 child PG 完全回收后核归属、停止并记录正面停态。有限卸货实际证明与最终完整 C3 仍待运行和独验。

该有限驱动实际在 931→938（七个 actual main）按上限保护停止，`matched=false / error=null`，没有进入 batch。153 条全 raw、失败及停态保持：driver `2b80205e042fda7cc99b5f006b25cc658603cf600a6fdfbf16b752d7796c50bb`，caller `6231fc22…`，supervisor `7aa2752a…`，当前 DB `57eff302b8cc785bd218adb698027480ac69a5c8746c0ef8c415ac8d6b19bdd9`。真实 Product30 已从 carrier 进入固定 Terminal `5ca4c1b028a9b3b`；Storage 未改变，UH10 / OH0、消费26 / closed4、40 条交易和任务保持，owned Energy 总量 `2555120→2555120`。938 / CPU937 与 10198ms 稳态证明提交端点，中间行不冒充全局原子 closure。

固定 Storage 的额外约束过窄，是本轮准备工具的判断错误。a24 `carrier.ts` 的非 Energy cleanup 本来优先 Terminal、Storage 后备；不能把 EnergyTargets 的 Storage 优先外推到 UH2O。新命名 Terminal 诊断 proof `5600953c7e8ae9044fcc940ed36b6453d4f7e3b514618780e2c15a29575336b4` 已双静态审查，只读验证全部153原行及实际固定 Terminal 端点，仍保留旧 `matched=false`，不把它改写为驱动成功。随后仅在当前938接首次 batch 和未执行尾部；原 goal931→batch.before 的直接 Memory 相等须用这段完整真实链桥接，不能伪造931字节。实际诊断独验与最终 C3 仍待完成。

Terminal 诊断算法自检实际 20/20 PASS、零跳过，报告 `728f810f9426fa6df5b79440623161167f0e07597cfd17b1826605e924cdf910`。全部153实际独验 PASS，报告 `ceb463788f51a92914489249845b39e96a417f507d34666e0f0a53d2fd593065` / provenance `a276ab4f12566511f274a5d166355a6159ae20a231e3d91eb87608f39bd8898a`。随后原 batch 在938首次写入，原 observer 取得恰好60条938…997的实际样本，UTC全部位于原 driver `05:52:44.982…05:54:26.984` 窗口；消费仍26 / nativeCalls3 / HWM4 / currentCycle null，原40条交易保持。

尾部“预算耗尽仍新建任务”断言再次失败并保全：held998、caller `cec98d63…`、supervisor `6c587864…`，05:54:29 UTC正面停态，DB `3af30bda2b9b88c6f8f8c2b85bf61abcc827658c5f44e46875090f89fc5fd9eb`。精确诊断表明唯一时间筛选误命中是原 `74075640:1:OH:E4N58->E1N57`（cancelled、1384/913、生产 createdAt74075640）；它在938需求前已存在，前后整JSON与原972403历史全文一致，不能把生产 namespace 的时间戳与隔离 tick938比较后称为新建。全部60帧三条 canonical OH 身份与摘要保持，两端完整 JSON 相同；端点未新增任何 RC ID。六条旧done UH/H行正常GC，其原行与严格大于200tick合同另行核验。不改旧任务时间或删除它，不重60窗口，新命名证明与同998的原stop→stopped→普通OH10交还尾部待闭环；producer原尾不含额外cold/reenable，不把其它场景的冷验证冒充本场景。

窗口证明算法自检实际11/11 PASS、零跳过，报告 `f9f97abaaa03aecf877bf77ab8244f6187a9bff653b3b2f5aac9253fe49235e2`。06:33:57 UTC前后DB3af字节保持且正面停态；原完整60窗口只读独验实际PASS，报告 `cfa5dc6e7162f6d5f9bfc116f4eaf53ecd681be3fd3488e144fadb17591f21e4` / provenance `587dd1255326734fac14e5de30dd70de2948d22186ff42606d222493c29f9131`。新游标只执行原失败断言之后的首次 stop→普通OH10尾部：999已 off/stopped、消费26/Native3/HWM4/currentCycle null不变；1001普通OH10新任务交还完成，raw41（仅增加普通任务交易），T4消费仍10/10/6。producer及原完整C3强独验仍待实际完成。

## 最终完整 C3 结果

producerBudget 子场景主独验实际 exit0 / PASS：主报告 SHA `6e578e87a8bfddaafa7d2147ed38657ca5806fdb9de101c22d0fd74092968bc6`，provenance `b74e64013c691157887a2219ffebf7a850029dee5ad21bbe2337efb1e896302a`，准备及同 claim 完成来源独验 `f61a55a59cd65f347219bdd1eaa7b20fac283dc739eaee3502692fd1a2dd61ea`。

随后原完整 C3 主入口以 `--case c3`、不指定子场景实际 exit0 / PASS：主报告 SHA `d7d186264ad2504884f297bd2e9a52e02670414f34e2b41820f5ae21627c4d3d`，provenance `b6a6bb1431dc68e347d8054de2a4756180744ee5d08e7159d57d2c94b3de3c05`。完整读取三个独立世界；未拼接子报告或手添 complete 标志。两次只读核验前后 workingDB 均为 `f01eb80d842aeea12a2f4448b8013c7aa7d59d2f7b9ee4c48fcba2bf661a5525`，没有新增游戏执行。

最终正面停态回执 SHA `cf513a46674e71f91443539d3dccb870d49924963b960386f52a155b5a3ff841`：2026-10-03 07:25:19.784575 UTC，实验 unit inactive/dead、MainPID0、三个回环端口拒绝，无可运行实验进程；实际持久 tick1001、main9d300172…、workingDBf01eb80d… 均匹配。

完成来源组件 `813628a9442488adc78afa172241c45e85b43584371ef1d22212114b930b0708` 先独验原全部153条卸货记录、60条预算观察、四段同 claim 的监督与数据库链，再仅替换原准备工具两处 completed 判定。原三个真实失败及其 exit1 保留，最后一段真实 completed/exit0 单独证明；原恢复/对齐/设置次数、准备 proof、历史、签名、bundle、冷恢复与窗口门不变。partial 入口 `0ab195cc…`、full 入口 `90ea2b12…` 已双重静审封板。此前缺私有数据库副本的失败报告 `9756bd9d…` 保留，configured/completed 原 DB 按原 persistence SHA 精确复制后才完成独验，没有重建或修改数据库内容。

## 正式服

2026-10-03 15:23:40.527 至 15:23:44.660（北京时间）的最终四 shard 纯 GET 确认，正式代码仍为 `1bf02d8415f552239dd034865c4e62d5c6a00a978af36f78b64640ea05f6f061`，tag 为 `2026.10.2-1+447ab5c@2026-10-02T06:10:35.260Z`。E1N57 已启用房间的 `reactions=[]`，运行态 idle，合成采样 updatedAt74095867，缺少直接 UH2O 计划及匹配 OH pending canonical 任务，无法计算有效 pilot。早间08:33的 XUH2O 配方及净 OH160 是旧快照，不作为当前状态。

E4N58 当前 Storage OH70 + Terminal OH48，捕获 floor / 其它 pending 出站 / 未过期持久 reservation 均为零，有限物理净 backing 为118。GET 未证明外房 accepted assignment 与完整 heap 责任，不能据此授予 permit。四 shard 捕获不到持久 Treasury cfg/runtime、Core active 或 task lease。正式服最新旧部署 CPU 样本 tick74095861，used52.9035 / bucket10000 / limit120 / tickLimit500，与捕获观察 tick 差6；不是新候选的性能验收。shard1 Memory 1,527,878 字节，预留8192后1,536,070，低于1,900,000。不得复活旧取消任务、改配方或补发凑验收。

最终检查仅8次 GET、零 POST / console / 业务写入。原件 capture SHA `8091dfece2ce9403b0acd5ef509ef9efc1c7f865367bb929003552540fa958ba`，有限投影 SHA `4f5c3ef1baf90ba55dc89fd8e290f5b6650d72e7b41367cefea1978c16e16d7a`；完整正式代码与 Memory 保存在仓库外700私有目录、600文件。本轮尚无正式代码上传或国库业务写入。后续上线需重新取得真实入口需求、供给与动态权限，并取得正式回执、接受及健康观察证据。

## 可定位原件

- 仓库内源码验证、函数微测与 R6 manifest：`docs/reports/treasury-T4-architecture-evidence-20261003/`。
- 仓库内完整 C3 的35项原字节小报告及包 manifest：`docs/reports/treasury-T4-architecture-evidence-20261003/final-c3-r5/`；本机再次逐项核对全部 SHA。
- 完整本地轻量证据根：`/Users/forst/Downloads/screeps-treasury-autonomous-20261002/`。
- R5 C1 完成说明与三件独验来源：`engine/t4-r5/recovery/C1完整独验完成-20261003.md`、`engine/t4-r5/recovery/c1-independent-20261003/`。
- R6 性能、停止故障、原失败与来源封板：`engine/t4-r6/r16-small-report-package/`。
- R8 完整 C1 成套独验：`engine/t4-r8-architecture/recovery/c1-completed-r18-r3/`、`engine/t4-r8-architecture/recovery/C1当前字节完整独验完成-R18-20261003.md`。
- R8 完整 C4 与明确双限额口径：`engine/t4-r8/r18-small-report-package/`、`engine/t4-r8/R18隔离性能结论-r4.md`；冷查询澄清保留于 `cold-benchmark-correction-r4.json`。
- R8 C2 与完整 C3 主独验及来源：`engine/t4-r8-architecture/recovery/semantic-small-report-package-r18/`。
- 最新正式服纯 GET 预检：`t4-inherited-readiness-preflight-20261003-r4/`，目录700、原件600。
- 大数据库、完整 Memory/Store/CPU/console 原件保留服务器：`/srv/screeps-treasury-t1/r15-t4-r5-20261002/`、`/srv/screeps-treasury-t1/r16-t4-architecture-20261003/performance-r1/`、`/srv/screeps-treasury-t1/r17-t4-architecture-20261003/`、`/srv/screeps-treasury-t1/r18-t4-architecture-20261003/`。
