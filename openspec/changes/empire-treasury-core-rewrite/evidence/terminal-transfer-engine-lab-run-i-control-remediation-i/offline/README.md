# 离线验证归档（Control Remediation I）

三段验证的全部原始输出（每条命令含 command/stdout/stderr/exit-code；Jest 另存 JSON）。
执行环境：Windows/Git Bash、Node v22.19.0、仓库 `D:\code\screeps\screeps-bot`。

## first-round-directed/（补丁原样状态，未做任何修改）

按 AGENT-VERIFY §5 顺序：`npm ci` → `node --test`（三 spec）→ `tsc -p tsconfig.json`
→ `tsc -p tsconfig.build.json` → `npm run build` → 定向 Jest（probe/runI/calibration/
controlRemediation 四文件）→ Slice0 三文件。**七条命令全部 exit 0**：
Node 83/83、lab 4 suites/46 tests、slice0 3/23。补丁原样状态无需任何环境适配
或代码修复——这是"先原样验证"的首轮记录。

## 独立增补与提交

Agent 独立失败输入（不复制包内测试）在首轮之后实施：

- `calibration.test.ts` +7 用例（R02）：配置侧非法 targetTick（小数/负数/字符串/
  null）、早期样本 feeQuote 整字段缺失/null（quote 三项全 fail）、pauseConfirmedTick
  类型非法、两端"稳定但发送条件不满足"（源 cooldown=10/源 energy=20<cap/目标空位
  =50<100，同时断言对应 *_stable 项仍 pass）、controller level 稳定为 5、三样本
  反序时中间样本 target.cooldown 缺失不被排序掩盖（健康三样本反序 pass 且输入
  字节不变）、T0 边界（T=T0+2 fail、T=T0+3 pass、T0 与最后样本同 tick 的边界）。
- `tools/independent.spec.cjs` +6 Node 场景（R01/R03）：initialize 拒绝已存在控制槽、
  写后世界推进中止且无第二次写、暂停后存储与玩家读数不一致不算玩家确认、formal
  前置拒绝（send_precondition_rejected）即时停止、formal 窗口出现 control-probe
  输出即 wrong_active_entry 停止、control 模式第一条错误记录即时停止。
- `controlRemediation.test.ts` wrapper 数组扩展 `independent`（3→4 用例）。

**测试修正披露（增补测试自身、非实现修复）**：首轮增补有 3 个测试断言与实现
语义不符被修正——(a) latePause 边界变体算错（T0=197 时 T=200 恰为 T0+3 合法，
改为 T=200 pass / T=199 fail 的正确边界）；(b) "写后世界推进"的 fake 端口调用顺序
不对（readback 比对先失败），修正为写成功后第三次稳定核对才观察到推进；
(c) control 模式即时纠错样本缺健康端点字段，先触发 `control_world_unhealthy`
分支，补全健康端点后到达 `control_mismatch`。修正后 Node 6/6、Jest 17/17；
被测实现零改动。

实现提交 `b3207f9`（IMPL_HEAD，19 文件）；全仓收集 243/1497 后锚点提交 `d0103c9`
（VALIDATION_HEAD），`npm run test:budget` PASSED。

## formal-validation/（VALIDATION_HEAD=d0103c9 上的正式回归）

`npm ci`、tsc×2、`npm run build`、jest-lab（整个 lab 目录 4/54）、CLI 三路径
（healthy 0 / mismatch 1 / bad-input 2，仓库既有 fixtures）、jest-slice 3/23、
jest-treasury 35/597、jest-defense 11/118、jest-full 243/1497、budget PASSED、
四产物构建（observer/single-shot/main 三模式 + 只读 control-probe）、冻结×6
（src/生产/根配置/冻结 lab 九文件/两旧证据根——对照 BASE=d69726a 与
PROD_BASE=869149d 全部 `--exit-code` 0）、`git diff --check` 0、终态
HEAD=VALIDATION_HEAD 且工作树干净。`full-name-status.txt` 为完整差异清单。

**dist 不覆盖核对说明**：`dist-main-before.txt`（dad050be）是 npm ci 前上一轮
遗留的生产 bundle（含旧 buildTime）；`dist-main-after-prodbuild.txt` 与
`dist-main-after-lab-builds.txt` 均为 ed34291d——本轮生产构建后，四个实验/只读
产物构建前后 `dist/main.js` 字节一致，未被覆盖。生产 bundle 跨构建 hash 不同
是 buildTime 所致，不作源码冻结判据（源码冻结由 freeze-production 证明）。
（注：shell glob 字母序为 after-lab-builds/after-prodbuild/before，初读时曾误
将第三行认作 after-lab-builds，本段为更正后的正确对应。）

## second-tree/（同一 VALIDATION_HEAD 的第二干净 worktree）

独立 `npm ci`（不共享 node_modules）后复跑：`node --test` 四 spec **89/89**
（83 包内 + 6 Agent 增补）、jest-lab 4/54、jest-slice0 3/23、四产物重建与主树
**六产物逐字节 IDENTICAL**（observer.js/single-shot.js/main.js/两份
example.experiment.json/control-probe main.js；bundle 不含非确定值，仅 manifest
的 generatedAt 不同）。按既定规则不重复全仓压力与 budget。worktree 目录已清理。
