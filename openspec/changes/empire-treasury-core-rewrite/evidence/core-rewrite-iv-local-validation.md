# Empire Treasury — Core Rewrite IV 本地验证报告

日期：2026-09-06。性质：Agent 本地验证记录（无独立 CI；全部命令与日志见
本目录 final/）。任务书：`treasury-core-rewrite-IV-implementation.md`。

## 1. 版本与锚点

| 项 | 值 |
| --- | --- |
| 起点远端 HEAD（任务书核对） | b6c87c1cd45742882075e43f068b3470fcd301c8 |
| 本轮提交 | 58d24fa（内核实现）→ c33cbd6（D 矩阵/适配/基线脚本）→ 250dafd（文档+基线/负向变体证据）→ aba6b3b（budget 222/1260）→ 最终分支 HEAD 见 final/head-after.txt |
| 最终验证 HEAD | aba6b3b77ee50a625ce1439bbeb5038bb7cb7889（validation-head.txt；验证前后工作树干净、HEAD 不变） |
| budget 代码锚点 | c33cbd6e59518a2d75ba5a350b88a69559b0767e（requiredBaselineCommit 与 manifest baseline/target 一致） |
| schema | treasuryCore 保持 v3（子树结构不变；新增独立键 `Memory.runtime.treasuryWorldSequence`；runtime.d.ts 指纹 2d2cd73f…） |
| bundle sha256 | 9ff1c22ef49de21e60e76f3a543d6aa1e80c4544a889b660777bb9b8eb19b69d |
| 环境 | node 版本见 final/node-version.txt；npm 见 final/npm-version.txt |

## 2. R1–R7 → 实现 → 证据

| R | 缺陷 | 实现 | 验证 |
| --- | --- | --- | --- |
| R1 | cleanup 删除 committed 不考虑观察接管；旧 facade 复用删除前观察 | advance_cleanup 命令边界四要素（结论/观察证明/义务空/发布成功）；observeForCleanup 端口（facade 共享观察装配）；ensureTickState 视图时效（epoch.worldSequence < 持久世界序 → 重建） | 基线 R1-1/R1-2 红灯（8 红）→ D01/D02/D03/D12；治愈复验 16/16 |
| R2 | evaluateRevalidation fresh 不可用回退旧快照 | fresh null → 结构化阻断 observation_unavailable（调用 0/许可不消费/保持 pending） | 基线 R2 红 → D04/D05；负向变体 B 复现回退则 D04 红 |
| R3 | commitment incomplete 只影响 query，授权按剩余数值放行 | evaluateTreasuryAdmissionFacts 完整性门禁（scope incomplete 阻断，三入口与 query 同源）；commonReadinessGate（reservation 迁移/健康） | 基线 R3 红 → D06（authorize 前/真许可后两时点）/D07/D08 |
| R4 | 8 次释放耗尽预算后确认命令要求第 9 份 → 永久卡死 | 成对单位：端口调用前预扣完整 2 份；确认与失败诊断命令 0 份额（applyPrepaidCleanupCommand） | 基线 R4 红 → D13（8 义务 ≤3 完整预算 tick）+ D17 重入共享；负向变体 C 复现 +1 则 D13 红 |
| R5 | retry_ready 未写回空 consumerKeys；rearm 复制旧集合 | advance_cleanup 始终持久化真实 remaining；validator 强制 retry_ready ⇒ not_executed+空义务+证据一致；child 不继承义务 | 基线 R5 红 → D14（释放恰一次）/D15/D20 |
| R6 | 手写槽位公式低估（键引号/数字位宽/漏 worldSequence；修正后 ≈373,226 > 360,000） | 构造器实测法（buildTreasuryCoreWorst* → 真实 JSON.stringify = 上界）；validator 真实收紧（腿数 12、generation/adapterVersion ≤9,999） | 基线 R6 红（实测 > 公式）→ D21（4 例逐项对照）/D22（真实接纳满载实测 + 数学断言）；构造器实测合计 ~343,500 ≤ 360,000 |
| R7 | reset harness 保留 global 世界序；跨域直接比较（永久扣留/误判） | 世界序权威迁 Memory.runtime.treasuryWorldSequence（持久域）；global 槽退役（ABI 白名单移除）；harness 清 Treasury global | 基线 R7 红（新观察接管后 700 获准——现状拒）→ D09（接管/不双扣/无重复调用）/D10（无关推进不当覆盖）/D11/D18/D23 |

### D 矩阵额外发现并修复的实现层缺陷

1. **预算耗尽 continue 空转致结构性饿死（D19）**：清理循环预扣失败后
   continue 把 cleanupCursor 推满一圈回到本 tick 起点——后方记录永远落在
   "预算已尽"访问位。修复：立即 break（游标停在耗尽处，起点前移）。
2. **失败诊断 +1 份额挤占（D19）**：端口 false 的诊断推进原本 +1 份/条
   （成对模型下失败记录 3 份/条），把每 tick 预算挤成"后方可完成记录
   永远差 1 份"。修复：诊断命令使用已预扣份额（成对语义一致化）。
3. **晚到 reconcile 记录无 invocation 锚点（D11）**：settle 路径不改
   invocation——观察覆盖判定对 external accepted 记录无锚点可用。修复：
   锚点回退 external.atTick（tick 边界判定）。

## 3. 测试与验证结果（验证 HEAD = aba6b3b）

| 命令 | 结果（final/ 内日志与 JSON） |
| --- | --- |
| npx tsc --noEmit -p tsconfig.json | 0 错误（exit 0） |
| npm run build | 成功；dist/main.js sha256 9ff1c22e…（本地构建，无 deploy） |
| jest src/runtime/treasury/ --runInBand --json | 20 suites / 425 tests / 425 passed / 0 failed |
| jest --runTestsByPath（Defense 冻结 11 文件） | 11 suites / 118 tests / 118 passed |
| jest 全仓 --runInBand --json | 222 suites / 1260 tests / 1260 passed / 0 failed / 0 pending / 0 todo |
| node scripts/verify-jest-budget.mjs（追加验证，自带全仓重跑） | JEST_TEST_BUDGET=PASSED（222/1260；锚点 c33cbd6） |
| git diff --check / status-before / status-after | 干净；验证前后 HEAD 一致 |
| 基线重现器（b6c87c1 worktree，--runTestsByPath） | 8 failed / 8 passed（exit 1）——见 baseline/ |
| 治愈复验（修复后代码同一脚本） | 16 passed（scripts/baseline-red/treasury4-boundaries.baseline.ts） |
| 负向变体 A/B/C | 2/1/1 failed（exit 1，语义断言失败）→ 还原后 425 全绿——见 negative-variants/ |

Budget 变化：220/1228 → **222/1260**（+treasuryRewrite4Acceptance 20、
+treasuryRewrite4Lifecycle 12；无 skip/todo；protected-full 15 文件保持）。

## 4. 关键行为数字（D 矩阵实测）

- 成对预算：8 义务 closing 于 2 tick 完成全部调用+确认、t2 终态
  （D13 remaining 轨迹 8→4→0）；每 tick 端口调用 >0 且 ≤8（单 tick 实测
  4 单位/8 调用上限语义保持）；同 tick 重复入口幂等重试或零调用。
- 公平性（D19）：8 条永久失败 + 1 条 8 义务可完成 + 每 tick 新 pending
  噪声 → **12 tick 完成**（推导界 8 次访问 × ~4 tick ≈ 32，实测优于此）。
- 观察接管（D09/D23）：heap 全清 + Memory 保留 → 新观察接管退出，无重复
  调用（executions 计数不变），余额不双扣（世界 = 初始 − Σ已确认流出，
  与独立参考模型一致）。
- 空间上界：构造器实测 64×slot + 128×ring + meta ≈ **343,500 ≤ 360,000**
  （D22 真实接纳满载实测亦 ≤ 预算；bytes 与字符数相等——受控字符集）。
- 操作界：清理循环每 tick 访问有界（预算耗尽 break）；查询零写；预扣
  发布 1 次/单位；确认 0 份额追加。

## 5. 支持模型与未完成项

- 受支持模型：**同步生效受控测试世界**（adapter/宿主写世界时 bump 持久
  世界序）+ 完整 reset（heap 全清、Memory 与宿主世界保留）。混合模型
  （部分效果不 bump）不支持（design §4.5）；真实 driver 的"效果保留而
  Memory 回退"非原子窗口未验证——**真实经济 writer 保持禁用（部署阻断）**。
- 未完成项（结论而非待办）：真实 driver 接入与受控 external settlement
  capability；外部消费者释放端口的生产装配；旧 Memory 在线迁移器（不建）。
- 本轮未部署、未合并 main、未使用玩家凭证或真实玩家 Memory；未恢复任何
  旧 proof 体系（authority-retirement-map §-1 逐项确认）。

## 6. 独立 CI 状态

无（仓库无独立 CI 配置可用）。以上全部为 Agent 本地验证；未把空 checks
当通过。真实 combined status 查询不可用（无凭证）——如实记录。
