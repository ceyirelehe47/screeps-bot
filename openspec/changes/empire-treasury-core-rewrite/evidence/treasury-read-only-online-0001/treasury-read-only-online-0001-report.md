# Treasury Read-only Observation I — 线上基线核对与限定采样 0001 · 主报告

日期：2026-09-10 · 起点 `828a078473c97562219d9cb5abfdd6df2ef5c79b`（HEAD=origin，工作树干净）
**终态：`ONLINE_BASELINE_REVIEWED / NOT_DEPLOYED`**（任务书 §9.1 推荐标签；阶段A出口 1——线上基础与候选相差整个国库重构 + 部署授权未取得，合法停在部署前）

## 0. 一页结论

| 维度 | 结论 |
| --- | --- |
| 线上基础 | 官方服 `screeps.com`，账号 `forster`，shard1（唯一有房间的 shard，8 房）；世界活动代码分支 `default` = **commit `06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c` 的构建**（2026-08-29T14:28:59Z，版本 2026.8.29-6，即库存影子 Phase 3 canary 重部署）；与候选 HEAD 相差 **432 个提交**，含国库核心 63 文件、Defense 全线、resourceControl 重构与 Memory 类型变更——**基础迁移，非只读增量** |
| 代码部署 | **未执行**。零上传、零覆盖、零分支切换、零 console 表达式注入、零 Memory 写入。仅只读 GET ×11（collect-manifest 10 次：5×200 + 5×429；另有 1 次 Memory 重试首探 429 后放弃——合计 6 次 429 未获数据） |
| 采样结果 | **未执行**（阶段B/C 未进入；无任何样本，也无观察器运行） |
| 关闭状态 | 不适用——线上从未部署观察器，无需关闭；线上代码与 Memory 未被本轮触碰 |

## 1. 阶段A执行记录

### A1 本地与远端起点（a1-baseline/）

- `git status --short` 空、分支 `refactor/empire-treasury-rearchitecture`、HEAD=`828a078…`、fetch 后 origin 同 SHA、`git log -8` 与预期链一致、未跟踪残留 0。
- `src/config/treasuryReadOnly.ts`：`enabled=false`、`shardName=""`、`rooms=[]`（默认关闭交付配置原样）；LAB `test/lab/treasury-integration/enabled.ts` 仍为 `false`。
- 构建/上传/守卫行为复核与任务书 [S4][S5][S6] 一致：`npm run build` 仅在 DEST 未设置时为 build-only；`npm run push`=`DEST:main` 重新构建并上传（screeps.com，branch=`default`，len=7 与 .secret.json 一致）；守卫拒绝脏树但有 override 与分支回退，"守卫没报错"不构成目标正确证明。
- 凭据形态（未打印值）：`.env` 仅 `SCREEPS_TOKEN` 一键；`.secret.json` `main` 为官方服目标（hostname=screeps.com、token 36 位、branch 7 字符）。dist 不入库；磁盘 `dist/main.js`（4,941,691B，sha256 `fdc7c534…`，BUILD_COMMIT `5c8a9d3`）为候选构建身份。

### A2 线上对象识别（a2-online-facts/）

- 通路：仓库既有 `screeps-api` 客户端同款传输（`X-Token`/`X-Username`，官方服 `https://screeps.com/api`），仓库外薄脚本 `read-only-collect.mjs`/`memory-collect.mjs`（纯 GET、不打印凭据、逐请求落盘+manifest）。
- 账号：`forster`（`634fe406347a7b69b28aeccb`）。shard 一览：shard0-3+shardX。
- 分支列表：`default`（**activeWorld=true**，活动）、`tutorial-1`（activeSim=true，仅模拟器）、`rollback-6fc4bf2-20260829`、`rollback-pre-canary2-20260828`（均无活动标记，为 8 月末事故回滚遗留，本地另有对应全量备份 `monitor-data/rollback-default-*.json`）。
- 活动分支模块集合：单模块 `main`，4,494,463B，sha256 `37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b`；`computeModulesHash`（仓库算法，名字排序+内容规范化）= `84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf`；原件备份于仓库外受控目录 `D:/code/screeps/incoming/ro-online-0001/a2-modules/main`。
- 三摘要分离（§B5 口径）：最终文件 sha `37d20706…` ≠ 内嵌 `__DEPLOY_BUNDLE_HASH__`=`7dce727e…`（自引行追加前计算）；集合 hash 见上。
- 内嵌构建身份（字节真值）：`BUILD_TAG="2026.8.29-6+06ffedb@2026-08-29T14:28:59.403Z"`、`BUILD_COMMIT="06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c"`、`BUILD_TREE="929fa9557b1a36135a5ef1605231be1d16e87366"`、`BUILD_DEPLOY_BRANCH="default"`。git 核对通过：`06ffedb` 在本仓库存在（2026-08-29 22:28:52 +0800 "chore(release): bump 版本至 2026.8.29-6（oracle 口径修复后的 canary 重部署）"），tree 完全一致。
- 部署 Memory 标签（`Memory.runtime.lastDeploy*`）：**直读未取得**——`/api/user/memory` 全线 429（见 A3 限流记录），原样标缺失；旁证：canary2 报告（2026-08-29）已验证该机制"与本地一致"地写入线上 Memory。
- 影响范围核对：overview 显示自有房间仅 shard1（8 房：W1N57/E1N57/E3N59/E4N58/E5N59/E6N59/E7N58/E7N57），其余 shard 房间数 0；`default` 为账号唯一世界活动分支——若覆盖，影响面=shard1 全部 8 房。
- 房间候选（仅供后续阶段B规划，本轮未使用）：昨日快照存能 W1N57 341K/E1N57 283K/E3N59 287K/E4N58 273K（hub 房）/E5N59 224K/E6N59 286K/E7N57 229K/E7N58 219K；**Storage/Terminal 结构 ID、容量与可见性未取得**（Memory REST 限流 + overview 不含结构身份）——如实标缺失。

### A3 相关状态只读核对（a3-state/）

- **限流事实**：`/api/user/memory` 对本 token 深度超支（首个请求即 429，Retry-After ≈ 17,600–18,057 秒且随请求增长；响应体含免限流链接——该链接为账号 token 设置变更，**明确不使用**；含 token 前缀的响应原件仅存受控本地目录，入库副本已脱敏为 `token=<REDACTED>`）。原因甄别：用户既有 canary3 监控采集器**正在运行**（`monitor-data/collect-canary3.log` 持续追加，其自身 memory 读取同样 429、remaining=0）——按任务书不关闭用户既有监控，本轮不与之争抢预算。
- 替代来源（均为本地既有材料，零新增线上请求）：`canary3.jsonl` 最后一份完整 Memory 快照（2026-09-09T18:55:01Z，tick 73597160）与当日 segment（id=90，独立限流、余量充足）遥测。
- `runtime.treasuryCore`：线上代码无此模块（标记 0 命中），快照投影中亦无——**不存在**（非"active=0"）。旧 `resourceControl`：**活跃**（available=true，roomCount=8，updatedAt 持续推进）。`resourceReservations`：随 resourceControl 体系存在（未逐字段展开，因只读投影不含该路径，原样标注）。
- 市场配置：`marketSaleAutomation` 存在但 available=false、requestedMode=null（该投影口径下未启用；在线代码含 `marketActionJournal` 逻辑，7 处标记）。
- CPU/主循环：cpuMonitor latest（tick 73597160）totalUsed≈69.83 / limit 120、bucket **10000 满仓**、tickLimit 500；相位含 marketSalePreflight(≈9.97)/productionMonitor/pixelGenerator/nukerControl/hubPlanner 等，**无 treasury 相位**。当日 segment 持续更新（tick 73612588，~20:37 本地）证明 bot 正常运行、无主循环异常信号。

### A4 部署差异判定（a4-diff/a4-conclusion.md）

**结论：需要单独迁移方案——停止部署。** 依据：在线 `06ffedb` ≠ 候选 `828a078`（字节级），`06ffedb..HEAD` 432 提交命中差异表第 3 行（facade/kernel/生命周期 + 生产/物流/市场/Defense + Memory 迁移）；且部署授权未取得（§2.3 上传属线上写操作）。根构建/依赖未变。最小待迁移差异与后续建议见 a4-conclusion.md（重点：线上活跃的旧 resourceControl/resourceReservations 与国库 commitments/reservations 的迁移衔接、runtime.d.ts Memory 兼容、Defense/各控制模块变化、main.ts 相位表首 tick 行为）。

## 2. 未执行的阶段与禁止事项遵守

- 阶段B（B1–B6）与阶段C（C1–C5）全部未执行、未造空材料。
- 未使用 noratelimit 链接（账号设置变更，越权）；未向 console 投递任何表达式；未运行 `npm run push/local`（连 build 也未运行——候选身份直接沿用已验证的磁盘 dist 与其 BUILD_COMMIT 记录）；未触碰用户监控进程；未制造任何交易/任务/预留变更。
- 429 响应体中的 token 前缀已脱敏入库；`.env`/`.secret.json` 值从未打印或提交。

## 3. Git 与验证纪律（§9.3）

- 本轮**零 src/测试/预算变化**：按任务书"阶段A止步且没有代码变化时，只交差异与证据，不额外跑全仓"，未重跑 Jest/预算（上轮 248/1539 按 §1.1 以历史归属引用，基线 37e3390/锚点 5c8a9d3 未动）。
- 本目录为本轮唯一入库材料；线上原模块与 Memory 快照派生物存于仓库外受控备份（`D:/code/screeps/incoming/ro-online-0001/`）。
- Git 收尾纪律：证据/文档改动与本报告同批线性提交于 `refactor/empire-treasury-rearchitecture` 并 push（GitHub push 与 Screeps 上传是两种操作，本轮仅前者；实际提交 SHA 见本轮 git log，报告落笔时提交尚未发生——本条为收尾纪律声明而非已完成事实陈述）。

## 4. 四结论回答（§9.4）

1. **是否部署**：否。未上传/覆盖/切换任何代码。
2. **是否取得线上只读样本**：否（未进入采样阶段）。
3. **是否已关闭**：不适用——线上从未运行观察器；线上状态未被触碰（默认关闭代码仅存在于本分支离线验证）。
4. **实际线上版本/候选/差异类别**：线上=构建 `06ffedb`（2026.8.29-6，2026-08-29）；候选=`828a078` 源（验证构建 `5c8a9d3`）；差异=432 提交基础迁移（国库核心+Defense+resourceControl+Memory 类型），非只读增量。
5. **未解决项**：Memory.runtime 部署标签直读（限流窗口 ~5h）；Storage/Terminal 结构身份；整bot性能影响量化；线上 Memory 与国库体系的迁移衔接方案——均移交后续任务。

## 5. 下一步边界

下一项工作是**单独的迁移实现包**（把 06ffedb→当前分支的国库基础迁移按 §A4"最小待迁移差异"立项，含 Memory 兼容性、分阶段上线与回退），而非本分支整体上传或把观察文件硬摘到旧版本上。观察器启用/采样须待该迁移完成并另行取得部署授权后，按本任务书 §5–§7 流程执行。本轮不自动启动任何后续任务。
