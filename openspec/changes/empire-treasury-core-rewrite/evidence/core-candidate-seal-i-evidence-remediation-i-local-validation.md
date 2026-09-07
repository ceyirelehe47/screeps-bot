# Core Candidate Seal I · Evidence Remediation I —— 本地验证报告

编制：2026-09-07。执行者：开发 Agent（实施 + 主验证）。任务书：evidence/core-candidate-seal-i-evidence-remediation-i/task/task-brief.md（SHA-256 6e3ff9a480e8b924eb142038f207ee5c963098aee1755444d8bb7a88c522e4a0）。

**结论分级（§9，逐层报告、不以一层代替全部）：**

| 层级 | 状态 | 依据 |
| --- | --- | --- |
| 生产状态 | **零生产/配置/Defense 差异（相对冻结基线 869149d）**，无新生产反例，内核不改写 | freeze/ 三组 `--exit-code=0`；差异仅测试侧 2 文件+预算元数据 2 文件+openspec |
| 证据工具 V1 | **完成**：原始字段"缺失 vs 合法 null"经提取/JSON 往返/比较仍被定位；基线拒绝不完整事实 | L01 it + 基线反例红→绿对照（baseline/） |
| 证据工具 V2 | **完成**：每个标准检查点实际风险快照存在并与独立基线逐字段重算；缺证据/中间漂移/标签矛盾全部被拒 | L02/L03 it + 基线反例 A/B/C 红→绿对照 |
| 运行取证 | **完成**：主验证与第二上下文原始产物（日志/Jest JSON/轨迹/核验输出）齐备且相互对应 | final/ + revalidation/ |
| L01–L08 | 全部实际执行（§2 定位表） | 本报告各节 + tasks.md/test-migration-map §15 |
| 封板层级 | **本轮证据补修完成，候选证据提交独立审查**（独立验收结论见文末） | — |
| 部署边界 | **不授予部署许可**；不接真实 writer；不自动进入真实引擎适配 | §9 停止条件 |

---

## 1. 提交链与锚点

```
869149d（生产冻结基线，Remediation VI 终态后）
  └─ 7c79071  Seal I 终态（本轮编制起点 = 远端起点；本地=远端无前移）
      └─ 5360e66  test：V1 无损提取 + V2 逐点核验 + 敏感性 3 it（IVKernel 14→17）   ← 执行性变更
      └─ 6592705  chore(budget)：236/1420，锚点 5360e66                              ← 预算
      └─ d9cd60e  docs(openspec)：L01–L08 + 勘误                                     ← VALIDATION_HEAD（全部可执行改动在此之前）
      └─ <evidence 提交>  六目录证据 + 主报告（非执行：日志/数据/说明）
      └─ <验收补交>  独立验收结论
```

- 实施起点：7c79071（fetch 后远端=本地，工作树干净）
- VALIDATION_HEAD：**d9cd60e07f4c4e7559aec14383ee805aea0e2051**（validation-head.txt）
- 预算锚点：5360e66（236 suites / 1420 tests；requiredBaselineCommit=5360e66，requiredTarget 同步）
- 最终交付 HEAD：见 §6

## 2. L01–L08 结果与证据位置

| 编号 | 结果 | 证据 |
| --- | --- | --- |
| L01 | **PASS** | IVKernel `原始记录入口的无损风险提取` it：原始记录副本 delete invocation/external/outcomeEvidence（基线合法 null）经提取+JSON 往返+比较定位（expected null / actual {sealFieldAbsent:true}）；非 null 字段（invocationBoundary/identity/worstCase）delete 与金额变化定位；未修改记录/深复制/往返零差异；基线不随副本改变；缺字段/缺记录基线拒绝。基线反例（起点实现 3 红：diffs=[]）见 baseline/ |
| L02 | **PASS** | `逐检查点实证核验` it 反例 A（三项 null → "风险证据缺失"定位 seq=5）+ 相邻（快照缺 ID → "未覆盖全部"）+ 合成轨迹（unknownRisk=null → 拒）；核验器基线完整性（占位/缺字段/哨兵拒绝）。基线反例 A 红（被跳过）见 baseline/ |
| L03 | **PASS** | 反例 B（快照金额漂移标签一致 → 重算定位 worstCase[1].delta+attempt+标签矛盾）、C（中间非空 riskDiff → "标签非空但实际快照与基线重算一致"）、相邻 2/3（post-close 漂移/终态标签矛盾双向）；合法真实底版通过。基线反例 B/C 红见 baseline/ |
| L04 | **PASS** | `落盘写读往返` it：合法轨迹写读仍过、合法 null 读回 null、哨兵落盘读回保留且被拒、破坏副本落盘读回仍报差异、核验前后输入 JSON 不变；临时目录仓库外用后即清。基线反例错误均来自行为断言（非编译/缺模块——baseline-run.log 零 TS 错误） |
| L05 | **PASS** | J05/J06/零推进对照未改动（fixture 64/90、40/10 限值、非零服务、真实退出保持）；J06 全轨迹经新核验器通过（54 检查点逐点重算 problems=0）；行为数据与 Seal I 期一致（checkpoints=54/portEvents=96/bounded=13/recovery=1/chars=21879——实际采集非硬编码）；失败路径 incomplete 定格行为未触碰 |
| L06 | **PASS** | freeze/ 三组零差异+差异分类（无生产逻辑搬排除路径）；typecheck×2/build/jest-key 57/jest-treasury 574/jest-defense 118/jest-full 1420/budget PASSED 全部实跑于 d9cd60e；全部执行性改动（5360e66/6592705/d9cd60e）在验证 HEAD 之前（=验证 HEAD 本身） |
| L07 | **PASS** | revalidation/：reviewer subagent（未参与实施）在 d9cd60e 独立干净 worktree（npm ci 按原 lockfile、独立 Jest cache/输出目录）实跑冻结三组/typecheck/IVKernel 17/KEY 57/Defense 118 + 自导出轨迹落盘核验——每步 command/exit-code/log/Jest JSON 原件 + reviewer-log（身份、任务书读取与 hash 复算、环境）。旧 Seal I revalidation 无完整原始输出：无法从仓库补回，如实注明，不按摘要重造、不删旧记录 |
| L08 | **PASS** | 本报告 §3–§6；原 Seal I ACCEPT 不撤回（勘误：V1/V2 缺口属证据工具，未证明生产风险漂移）；新旧锚点/运行/hash 对应；未完成项无；部署许可不授予 |

## 3. 主验证摘要（final/）

见 final/README.md 与 commands.txt。全部步骤 exit=0：冻结核验三组、typecheck×2、build（bundle 91b561fd…，与上轮不同系构建时间/Git 身份嵌入，仅追溯）、KEY 5/57、Treasury 32/574、Defense 11/118、全仓 236/1420、budget PASSED、diff-check 0、HEAD 未移动、工作树前后干净。

**落盘轨迹机器核验**（verify-seal-trace.log）：核验实现取自 `git show d9cd60e:test/mock/treasurySealEvidence.ts`（blob fd930a4…）→ 四份 H18-J06.json（独立 Jest 进程目录互不覆盖）逐份 bytes=1180356 / checkpoints=54 / completed=true / problems=0，各自 sha256 记录。**Jest JSON 核验**（check-jest-json.log）：四份可解析，failed/pending/todo/runtimeErrors 全 0。

**事件记录**：verify-seal-trace 首跑因 /tmp 下 mjs 的 typescript 解析路径失败（脚本问题，非测试失败；此前全部步骤 exit=0），修复后 set -e 重跑尾段三步全过（final/tail-rerun.log；首跑现场保留 mainval-run.log）。其余步骤未重跑。

## 4. 第二执行上下文（revalidation/）

reviewer 为未参与实施的独立 subagent；worktree detached d9cd60e、npm ci 按原 lockfile 真实安装（896 包，非 junction）、独立 cacheDirectory 与输出目录；运行前核对 SHA/干净状态/任务书全文（413 行，hash 复算 6e3ff9a4…与实施者一致）。**独立 reviewer 属性满足**（非同执行者第二工作树）。

结果（每步原始 command/exit-code/log/Jest JSON 见 revalidation/）：冻结三组零差异、typecheck 0、IVKernel **17/17**、KEY 五件 **5/57**、Defense 十一件 **11/118**（共 192 测试全过）；reviewer 自导出轨迹（1,180,356 字节）落盘读回后经 d9cd60e 已提交核验器（blob fd930a4…）核验 completed=true/checkpoints=54/problems=0；worktree 前后干净、前后 HEAD 一致、结束即移除。旧 Seal I revalidation 无完整原始输出：无法从仓库补回，如实注明（不推断 reviewer 未运行、不按摘要重造、不删旧记录；见 revalidation/README.md）。

## 5. 未证明事项与边界（不变）

本轮支持模型仍为受控同步效果世界、选定持久状态保留后的运行时重建：不证明真实 driver 非原子窗口、任意旧备份回滚、整份 Memory 丢失、实际 Screeps CPU 或数据库式 exactly-once。V1/V2 缺口属测试侧证据工具，修复不构成生产逻辑变化（生产零 diff），也不构成"生产已发生风险漂移"的证据。40/10 仍为固定 fixture 回归测试限值（非一般完成时间上界）。

## 6. 交付与推送

- 证据六目录：task/ baseline/ freeze/ final/ revalidation/ negative-controls/（各自 README）
- 全部验证完成后归档；验证后仅追加日志/数据/说明（无任何可执行改动）
- git push + ls-remote 核验远端一致；查询 combined status/check-runs——空检查表示无 CI 证据（非 CI PASS）

## 7. 独立验收（补记）

独立验收 subagent 结论与 L01–L08 逐项核验：见 tasks.md Evidence Remediation I 段末行。
