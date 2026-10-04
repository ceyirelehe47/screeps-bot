# Boost 期间 carrier 反复清理与装载 lab

2026-10-04，shard1。用户已授权修复验证后直接上线。

## 原生现场与根因

线上基线为 `2026.10.4-5 / cd4ba188`。tick 74109879 的 boost 预留包含 E5N59 Bank `6ac18cb2f2d2638f00c92d9c` 和 W1N57 Bank `6ac17ea33463f83fef5eab64` 的 `reinforcement:g1` owner。tick 74109893，E5N59 的 synthesis 清理任务从 lab `6a015064f8c48e533c1e6e0b` 搬走 XGHO2，W1N57 的清理任务从 lab `69feabb3f8c48e40531d7116` 搬走 XUH2O；后续 boost 又向这些 lab 发布装载。

两房间的 `boostPause.createdTick` 从 74109885 变为 74109902，正好相隔 17 tick。定期清理器也每 17 tick 运行，但有效 owner 集合只包含 Bank 基础任务 ID、creep config args 和 War 世代 boost ID，没有加入 PowerBank 任务中的 `primaryBoostOwnerId` / `reinforcement.boostOwnerId`。因此仍有任务引用的预留被当成孤儿删除，合成暂停被解除，后面的 boost 模块再重建预留。

合成调度先于 boost 调度。即使当帧重新暂停合成，已发布的旧 lab 清理／装载任务仍可执行到下一帧，这是第二个冲突窗口。

只读证据位于 `/Users/forst/Downloads/screeps-handoff-20261004/boost-loop-{first,detail,owners,phase}-events.json`。没有修改现场 Memory、配置、任务或 creep 搭档。

## 修复

已发布源码 `e6609cc0964687a6eacf328e42cdfb1d153236a1`，版本 `2026.10.4-6`。

- 清理器保留 Bank 任务明确引用的主队／增援 owner，不用 Bank ID 前缀放行退役世代。
- 首次暂停合成时，当帧撤销该房间旧的 synthesis carrier 任务。
- boost 预留确认后，通过共用 task board API 删除与预留 lab 冲突的 synthesis 步骤，保留未预留 lab 的清理。
- 未改动主循环顺序、交通、财务源码或线上控制开关。

## 服务器验证

新增回归在旧源码上为 2 套／13 测试：10 通过、3 失败，分别复现有效 owner 被清理、首次暂停未撤销旧任务、已有暂停中新预留与清理步骤冲突。修复后跨 17、34 tick 保留有效 owner；撤销增援引用后回收其预留，删除 Bank 后回收剩余预留；未预留 lab 清理保留。

双类型检查通过，构建通过。服务器隔离目录 `/srv/screeps-treasury-build/boost-lab-loop-20261004/` 的全量结果为 231 套／1544 测试通过；传输新增回归时带入了两个 AppleDouble 元数据文件，导致两个伪测试套和唯一的源码清单断言失败。删除 `src/runtime/._memoryCleanup.test.ts`、`src/runtime/._powerBankBoost.test.ts` 后，不改源码重跑 `typescriptConfigBoundaries`，1 套／4 测试通过。覆盖合计 232 个实际测试套／1545 测试；没有把原始失败报告改写成成功，也没有声称清理后重新执行所有测试。

发布工具同时绑定全量报告、清单重跑报告、源码 commit/tree 和冻结 main 字节，只接受上述明确的传输附带文件失败。

## 发布与现场核验

单次 POST accepted；独立 GET 与冻结 main 一致：3,544,190 字节，SHA-256 `d999c827757dc2ed40e09f6dbe983975c6c0af3efbe87bede7df91e7824019ac`。四个 shard 的 Memory 只读前检通过，未开启财务控制。工具、清单和服务器原始报告位于 `/Users/forst/Downloads/screeps-boost-lab-loop-20261004/`，原始代码／Memory 备份仅保存在私有 `upload-audit/`。

tick 74110208 原生运行确认标签 `2026.10.4-6+e6609cc@2026-10-04T00:05:50.534Z`，commit 与 tree `5315066af032aa377db642b5e16319a06485f591` 均与清单一致；append 前 bundle hash 为 `1543bf58e43359e0db423d950b6161935927dba8b552f9e03fecd7ee6c653033`。

tick 74110116（发布前）和 74110208（发布后）的 boost 预留均已为空，两房已恢复正常合成。因此当前原生数据只证明版本实际运行，不能声称在新代码下验证了活跃 boost 跨清理周期；下一轮自然 boost 仍需现场样本。没有为了验证而创建额外任务。

同一批只读日志在发布前记录了 `minimumExitMoves / exitExposureTicks / constrainTowerDrainBreachPath` CPU 超时，发布后记录了 bucket empty；这是继续进行的寻路／CPU 工作，不在本次 lab 修复的完成声明里。证据为 `boost-loop-pre-publish-events.json`、`boost-loop-after-publish-events.json`。
