# Treasury Read-only Observation I

## 目的与状态

在正常 bot 主循环旁边观察库存与现有占用，为之后的生产接入提供数据。不是新的国库、调拨策略、授权入口或线上发布许可。首条国库本地真实闭环已在 `cf29a69477a7c2ddd863efb800e9e8735e9b3cce` / `lab-ti1-0002` 取得限定通过；本功能不重新进行该实验。

本实现基于 `77d67d6a02cfb55029515e00503b598a78870ae5`。交付时默认关闭；开关与采样范围在 `src/config/treasuryReadOnly.ts`。合法采样profile在创建时冻结，外部修改不会混用前一范围的历史。没有新增 Memory 配置字段、全局命令、网络请求或实验开关覆盖。`test/lab/treasury-integration/enabled.ts` 继续关闭且不属于本功能依赖。

## 接入位置与只读边界

正常 `src/main.ts` 保留原有41个阶段的顺序，只在 `treasuryShadow` 后、`treasuryEndTick` 前增加 `treasuryReadOnly` 阶段。沿用同一个 `getTreasuryService()`，不新建服务，不调用 begin/end、authorize、execute、settle、cancel、rearm、注册 policy/adapter 或世界序推进。

`src/runtime/treasury/readOnlyObservation.ts` 只有类型依赖；薄装配位于 `src/runtime/treasuryReadOnlyRuntime.ts`，避免从国库内部反向引入 runtimeServices。模块加载不读取 Game/Memory。观察器内部捕获异常，不包裹整个主循环，也不改变其他业务原有 fail-fast 语义。

**零写指新增观察器本身。** 原 bot 的业务、国库生命周期、旧 shadow 与 profiler 仍按原顺序运行；旧代码可能创建/迁移 Memory、执行原有经济动作或写监控数据。开启既有 CPU profiler 后，新阶段也会被原 profiler 正常计时、随其既有 flush 输出。不能把整份 bot 叫作“全局只读”，不能以这个功能只读为由跳过对实际线上版本与待上传分支差异的核对。

## 观察范围

一次最多显式选择4个房间、4种资源，位置仅 storage/terminal。空房间列表不是自动扫描全帝国；资源也不是自动扩展成 RESOURCES_ALL×全部建筑。无 room.find、无全量 creep 遍历。

每个健康端点记录独立 Store 读数、Treasury 当前 observation 的指定范围比较、实际 query 返回的库存/占用/可支出/阻断原因，以及风险调整空位。资源为零、没有建筑、没有视野、非自有房间、读取失败分别表达；null、NaN、负数量、不一致容量不转换成健康零值。比较一致仅表示指定资源/端点的实物一致，不表示可以开始写入。

query 固定为不使用 projected/incoming、扣除 outgoing/reservations、无 owner 豁免、withhold=0。这样保留现有任务、预留和内核占用；但**未计算具体生产动作的战略储备 policy**。记录 `authorizesActions=false` 与 `strategyPolicyEvaluated=false`。即使 query.authorizationSafe=true 或 writeReady=true，也不是动作许可，不可将诊断输出反馈为执行授权。

任务与生产预留从现有 commitments 索引读取，只报告房间级 outgoing/incoming/reserved 和 completeness，不另扫原始任务表重算。房间级量不在 storage/terminal 间求和，避免重复计数。索引摘要、kernel 活跃数量/phase 汇总明确是全局摘要，端点库存不是帝国总量；kernel 不健康时 activeCount 为 null，不能用它的空返回数组冒充零义务。环损坏与权威损坏分别保留；kernel不存在也不抹掉单独检测到的legacyStores。端点query同样不是可相加的总额度：原服务可能在不同scope扣除同一房间级预留，不能把两个端点的spendable简单求和后花费。

## 操作来源与不确定性

市场线索只直读已有 `Memory.data.marketSaleAutomation.marketActionJournal`。保留记录的 tick、actor、kind、outcome，最多检查100条、输出最近8条并报告省略量；缺失、损坏、超界不混作健康空表。不输出完整 Memory、账户配置、订单凭证或任意 task payload。

不调用 `getTerminalActionClaims()` / `getMarketAccountClaim()`：当前它们会经 syncClaimTick 读取持久 claim，过期时存在删除行为，不符合新增观察器零写边界。`getMarketActionJournal()` 本身虽不删除，但会把部分损坏情况压为[]；这里使用有界原始只读投影以保留缺失/损坏差异，不复制仲裁权威。

该日志不是所有 Terminal/搬运/生产写入的完整审计，也不保证每笔 terminal.send 被它覆盖。intent、blocked、ok只是原日志语义，不升级为世界到账凭证。未记录不表示没有写入，tick很旧也不代表当前 actor 正在运行。

另外只保留上一份端点实物快照，输出相邻采样间的“未归因净变化”。不能把减少量当运费、把净零当没有动作，或把变化自动归给某个日志 actor。结构ID/容量变化、采样间隔超过3倍配置周期、缺失前样本或 reset 时不比较。后续线上写入仍需独立明确相关端点的所有 writer 和真实储备政策。

## 频率、预算与失败

默认每100tick一个采样点；最低20tick。最多4房间×2位置×4资源，即最多32次指定 scope 的 query，另有少量索引与摘要读取。实际 facade 可能复用或重建全局索引；这是既有接口内部成本，不是32次查询就能证明固定 CPU 上界。

默认仅 bucket≥2000，且当前 tickLimit 剩余不少于 reserveCpu(5)+maxSampleCpu(2) 时启动。读数在昂贵操作之间检查，预算不足后停止后续读取并标明 partial_cpu_budget。**这是协作式工作预算，不是2 CPU硬保证**：一个同步 Store/索引调用、序列化、console.log 无法被中途抢占；日志中单独报告是否越过工作预算，旧 profiler 的阶段计时可覆盖完整调用。

一份正常采样只输出一行 `treasury-read-only` JSON。默认上限16384 UTF-8字节，可配置1024–32768；超界输出明确的 output_limited 摘要，不截断成非法 JSON、不把省略内容说成健康空数据；未输出的端点快照不成为下一份净变化的隐形基线。每个 heap 生命周期最多额外输出一条意外错误通知。

CPU本轮序列化/输出前读数与上一轮完整采样（含序列化、输出）的成本分别给出。最后一轮完整成本若没有下一份采样，应使用 profiler 或测试返回的 stats，不伪造“本条已经包含自己日志耗时”。保留状态量采用上一份 primitive 快照的 JSON字符数，仅是可复核的体积代理，不是 VM真实堆字节，也不是全 bot Memory大小。

新增持久状态为零。heap只保留一次上次端点快照、上次成本、饱和计数器和故障停用标志，不积累历史。默认关闭、未到周期、CPU不足时不进入服务查询。普通端点缺失输出缺失事实；意外服务/CPU/输出异常停用该观察器直到模块重建，不重试业务、不调用“恢复”写接口。heap重建可丢诊断数据；没有业务义务随它丢失。

## 本地验证

```sh
node --test test/treasury-read-only/local.spec.cjs
npx jest --config jest.config.cjs --runInBand --runTestsByPath src/main.test.ts test/treasuryReadOnlyObservation.test.ts
npx tsc --noEmit -p tsconfig.build.json
npx tsc --noEmit -p tsconfig.json
```

Node 用例使用真实新增源码、模拟只读端口，并在旧业务端口模拟条件下执行真实 main 与真实新增装配。它不是完整 bot/引擎测试。Jest 用例连接实际生产 facade/commitments/kernel 读取路径；Memory Proxy拒绝并计数 set/delete/define 等尝试，前后快照相同不代替“没有尝试写入”的检查。

完整仓库、正式依赖与构建由验收 Agent执行。启用测试必须在测试注入配置内完成，不改默认交付配置来蒙混；需要真实环境采样或部署时，另行明确目标、范围和关闭方案。本文件及包内验收任务不授权正式服、PTR、既有世界、真实账号或新100H实验。

## 来源与语义依据

- `src/main.ts`：既有生命周期、shadow、profiler和经济阶段。
- `src/runtime/treasury/facade.ts`、`types.ts`：只读查询、索引、健康与容量语义。
- `src/runtime/marketActionArbiter.ts`：marketActionJournal及claim同步/过期删除通路。
- Screeps官方 API：Store返回值、Game.cpu.getUsed/tickLimit/bucket；<https://docs.screeps.com/api/>、<https://docs.screeps.com/cpu-limit.html>。

源代码研究是针对上述固定仓库SHA，不代表已核对实际正式账号的部署状态。
