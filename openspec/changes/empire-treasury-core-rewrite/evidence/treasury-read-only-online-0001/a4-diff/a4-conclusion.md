# A4 部署差异判定 — 结论：需要单独迁移方案（停止部署）

日期：2026-09-10 · 判定依据：任务书 §4 阶段A

## 判定

**线上基础与候选代码相差整个国库重构（432 个提交），且部署授权亦未取得——按任务书 §4 差异表第 3 行与 §2.3，停止部署，停在 `ONLINE_BASELINE_REVIEWED / NOT_DEPLOYED`。阶段B（profile/上传/采样）不进入。**

## 事实链

1. **线上身份（字节级真值）**：账号 `forster`（id 634fe406347a7b69b28aeccb），官方服 screeps.com，世界活动代码分支 `default`（activeWorld=true；`tutorial-1` 仅 activeSim，两个 rollback 分支无活动标记）。该分支单模块 `main`，4,494,463B，sha256 `37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b`，模块集合 hash（仓库 `computeModulesHash`）`84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf`。
2. **内嵌构建身份**：`BUILD_TAG = "2026.8.29-6+06ffedb@2026-08-29T14:28:59.403Z"`、`BUILD_COMMIT = "06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c"`、`BUILD_TREE = "929fa9557b1a36135a5ef1605231be1d16e87366"`、`BUILD_DEPLOY_BRANCH = "default"`、内嵌 `__DEPLOY_BUNDLE_HASH__ = "7dce727e…"`（自引行追加前计算，与最终文件 hash 语义不同，按 §B5 分开记录）。git 核对：`06ffedb` 存在于本仓库（2026-08-29 22:28:52 +0800，"chore(release): bump 版本至 2026.8.29-6（oracle 口径修复后的 canary 重部署）"），其 tree 与 BUILD_TREE 完全一致。Memory.runtime 部署标签直读因 429 未取得（原样标缺失）；写入机制经 canary2 报告旁证（2026-08-29 已验证"与本地一致"），且模块字节本身即真值。
3. **候选身份**：分支 HEAD `828a078`（=origin），验证构建 BUILD_COMMIT `5c8a9d3`，dist 4,941,691B sha256 `fdc7c534…`。与线上模块**非同一字节**（尺寸与 hash 均不同）。
4. **差异量**：`06ffedb..HEAD` 共 **432 个提交**。分类（见 diff-categories.txt）：openspec 2938 + test 67 + src 国库/只读观察器 63 + **src 其他业务 33** + 根/其他 18。其中"src 其他业务"含：Defense 全线（homeDefender/defenseFocusFire×3/defenderFrontEligibility/defenderRampartAllocation/homeDefense/physicalRampartOwnership/engagementFallbackRevision）、旧资源控制重构（resourceControl/resourceReservation）、logistics（resourceTransferTasks×2）、factoryControl、nukerControl、productionMonitor、synthesisControl、towerControl、memoryCleanup、runtimeServices、**Memory 类型声明 `src/types/memory/runtime.d.ts`**、main.ts/main.test.ts。根构建/依赖（package*.json/rollup/tsconfig*/jest/deployGuard）未变化。
5. **运行侧印证**（2026-09-09T18:55Z 快照 + 当日 segment）：线上 bot 活跃（tick 73597160→73612588），CPU 相位全景为旧代码特征（marketSalePreflight/hubPlanner/pixelGenerator 等，**无任何 treasury 相位**），旧 `resourceControl` 系统活跃（available=true, roomCount=8），`marketSaleAutomation` 键存在（available=false）。在线 main 中 `treasuryCore`/`kernelJournal`/`treasuryReadOnly`/`readOnlyObservation` 标记 0 命中、`marketActionJournal` 7 命中。
6. **受影响范围**：`default` 为账号唯一世界活动分支；overview 显示自有房间仅在 shard1（8 房：W1N57、E1N57、E3N59、E4N58、E5N59、E6N59、E7N58、E7N57），shard0/2/3/X 房间数 0。若覆盖 `default`，影响面即 shard1 全部 8 房（世界分支账号级生效，观察器自身的 shard 过滤不构成上传范围限制）。

## 按差异表逐行核对

| 差异类别 | 实际情况 | 处置 |
| --- | --- | --- |
| 已验收观察器模块+挂载+限定profile | 仅占 432 提交的极小部分，混在基础迁移中 | 不可单独摘出 |
| 构建元数据差异 | 无（双方同 rollup 管线；尺寸差 447KB 为业务代码差异，非元数据） | — |
| facade/kernel/生命周期、生产/物流/市场/Defense、Memory 迁移 | **全部命中**（国库核心 63 文件、Defense 14+、resourceControl 重构、runtime.d.ts） | **停止部署** |
| 来源不明/共享范围不明 | 无此项问题（身份已字节级确认） | — |

## 授权状态（独立于差异判定，同样不满足）

任务书 §2.3：上传/覆盖/切换活动分支属线上写操作，不包含在只读授权内。本次会话仅取得任务书对阶段A只读查询的授权（GET ×11，其中 6 次 429 未获数据），**未取得任何部署授权**。

## 最小待迁移差异（交回实现方，后续单独实现包处理）

线上 `06ffedb` → 目标 `828a078` 的全部 src 变更，重点衔接：
1. **旧 `Memory.data.resourceControl`/`runtime.resourceReservations` 活跃态**（roomCount=8、持续更新）与国库 commitments/reservations 体系的迁移/接管路径——线上 Memory 由旧代码持续写入，新代码首次运行必须能安全读取或显式声明不兼容；
2. `src/types/memory/runtime.d.ts` 的 Memory 结构扩展与旧 Memory 的兼容性；
3. Defense 侧车、logistics/factory/nuker/tower/synthesis/production 各模块行为变化；
4. main.ts 相位表变化（treasuryShadow/treasuryEndTick/treasuryReadOnly）与旧 Memory 的首 tick 行为。

以上任何一项都超出"只读观察增量上线"边界，需专门的迁移实现包（含 Memory 兼容检查、分阶段上线与回退方案），不由本任务处理。

## 未执行的阶段

阶段B（profile/构建/上传/三摘要核验/上传后确认）与阶段C（采样）**全部未执行**：因差异判定与授权状态双重不满足准入。未发生任何线上写操作、console 表达式注入或 Memory 变更。
