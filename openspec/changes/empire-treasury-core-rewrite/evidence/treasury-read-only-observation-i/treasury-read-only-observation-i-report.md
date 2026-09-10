# Treasury Read-only Observation I — 原样应用与独立验收报告

日期：2026-09-10。验收对象：交付实现包
`screeps-treasury-read-only-I-implementation-2026-09-10.zip`
（sha256 `7f6c1dd9287ed043d3c5916579cbec9ab4c8f7cdebd476a8ea71c2a534764ca3`，
patch sha256 `f280accda952959aa358989ebb12bce904de0ac072e445ecc79db4579b8d2d4b`）。

任务性质：离线原样应用 + 独立验收（AGENT-VERIFY.md）。**无线上部署、
正式账号、PTR、私服、standalone 世界或任何资源发送授权**；未运行
`npm run push/local` 或任何上传路径。

## 1. 基线与提交链

- 预期起点 `77d67d6a02cfb55029515e00503b598a78870ae5`，本地与远端核验一致，
  工作树干净后应用。
- 线性提交（无 reset/rebase/amend/force/merge）：
  - `d664256` 原样补丁 8 文件（实现 + 作者测试）
  - `5c8a9d3` 独立验收增补反例测试（`test/treasuryReadOnlyIndependent.test.ts`，17 例）
  - `37e3390` 预算滚动（246/1515→248/1539，锚点 5c8a9d3）
  - 证据/文档提交见本报告所在 HEAD（验证 HEAD=37e3390 与证据 HEAD 分离）。

## 2. 原样应用（S1）

- `apply_patch.py --check-only` → `CHECKED_NOT_APPLIED`（8 文件）；
  正式 apply → `APPLIED_NOT_COMMITTED_NOT_DEPLOYED`；`git diff --check` 通过。
- 应用后 8 文件与包内 `files/` 输出**逐字节 sha256 全部 IDENTICAL**；
  脚本内部已对每文件做 `git hash-object --path` 规范化 blob 与 manifest
  `afterGitBlob` 核对。
- 仓库两个原文件 HEAD blob 与 manifest `beforeGitBlob` 一致
  （main.ts `8669f0c4…`、main.test.ts `7c80d207…`）。
- 锚点保护反例：本轮 HEAD（37e3390）上重跑 `--check-only` 被拒
  （`wrong baseline … no auto-reset/rebase`，EXIT=1），见
  `01-apply/apply-record.log`。

## 3. 原样首轮（S2，仓库锁定依赖）

Node v22.19.0 / npm ci EXIT=0 / TypeScript 5.9.3（仓库锁定；交付端仅做过
TS 5.8.3 局部检查，本轮为首次完整检查）：

- `node --test test/treasury-read-only/local.spec.cjs`：**54/54**，零失败/跳过。
- `tsc --noEmit -p tsconfig.build.json`：EXIT=0；`tsc --noEmit -p tsconfig.json`：EXIT=0。
- 定向 Jest（main + 观察器两套）：**2 套 13 例全绿**
  （main 6 例原样保留 + 观察器 7 例）。

## 4. 独立反例（S3，真实 facade，每反例配合法对照）

新增 `test/treasuryReadOnlyIndependent.test.ts` 17 例 **17/17 全绿**，
覆盖 AGENT-VERIFY §5 七类边界（不限于作者用例）：

| 边界 | 反例（对照） |
| --- | --- |
| §5.1 门禁 | 错 shard / 低 bucket / 余量不足 / 非采样 tick / 同 tick 重复：四个只读端口（observation/commitments/query/kernelJournal）**零调用**（对照：同场景合法条件 sampled）；生产装配默认关闭运行级零输出 |
| §5.2 kernel/内存 | kernel 损坏（active:{broken:null}）不报 active=0（activeCount=null）、查询阻断保留、八个写端口（begin/end/authorize/execute/settle/cancel/close/rearm）零调用；Memory 缺失不初始化由作者 Jest 复证 |
| §5.3 Store 表达 | getter 抛异常 / NaN 读数 → unreadable（对照同房间或另一房间正常 match）；范围外资源 U 存在：amounts 仅含选定资源、used 差额=500、不扩大扫描、match 不受污染 |
| §5.4 双视图比较 | 同 tick 缓存后改库存 → mismatch 明细含 H+usedCapacity；替换结构 ID → mismatch 含 structure 且不污染资源比对；下一 tick 重观察恢复 match |
| §5.5 市场日志 | intent/ok/blocked outcome 原样不被当作成功转运；未来 tick 条目 unreadable；>100 条 over_bound；9 条相关输出 8 条 + omittedCount=1；无日志 absent |
| §5.6 输出/CPU | output_limited 整行省略通知为有效 JSON、不建隐形基线（retainedEndpoints=0，对照正常上限=4）；UTF-8 计数与 Buffer oracle 随机 200 串全对拍；慢 getter（每次读取 used+1）→ partial_cpu_budget / cooperativeCpuBudgetExceeded=true / kernel 与日志显式 not_read_cpu_budget（对照快 getter sampled） |
| §5.7 长期运行 | 连续 6 采样窗：单份上一次快照（retainedEndpoints≤2）、previousRun 单份有界（<2000 字符）、emitted 计数准确、无队列膨胀 |

**未发现被测代码缺陷**：开发过程中的 6 个失败均为验收测试自身装配错误
（spy 误用、破坏 getter 时序、对照房间未入 config.rooms、CPU 常数模拟、
断言表达式笔误），修正后全绿，与交付方 README「初轮 49/2 失败已修」的
迭代史相互独立。

## 5. 完整回归与预算（S4）

- `npm run build`（确认 DEST 未设置，仅构建）：EXIT=0，
  dist/main.js sha256 `fdc7c534…`（4941691B）。
  **默认关闭 bundle 证明**：dist/main.js L111075-111084 原样含
  `TREASURY_READ_ONLY_CONFIG = Object.freeze({ enabled: false, … })`。
- 全仓 Jest `--runInBand`：**248/248 套、1539/1539 例全绿**（711.6s）。
- 预算真实收集后独立提交：`test-suite-budget.json` 与
  `scripts/verify-jest-budget.mjs` 锚点滚动至 5c8a9d3、目标 248/1539；
  `node scripts/verify-jest-budget.mjs` → **JEST_TEST_BUDGET=PASSED**
  （第二次独立全量 725.9s 再证）。
- 冻结 diff：77d67d6..HEAD 全部变化 11 文件均落白名单；受保护路径
  （facade/kernel/observation/runtimeServices/旧 shadow/rollup/tsconfig/
  package*.json）**零改动**。

## 6. 第二干净工作树（S5，固定 SHA 37e3390）

独立 `npm ci` 后：定向 Jest 三套（main + 观察器 + 独立反例）
**3 套 30 例全绿**；两套 tsc EXIT=0；默认生产构建 EXIT=0。
两树 dist/main.js 仅 10 行差异且全部为构建元数据
（BUILD_TAG/BUILD_COMMIT/BUILD_TREE/BUILD_DEPLOY_BRANCH 与
__DEPLOY_BUNDLE_HASH__ 自引行；主树构建时点 5c8a9d3、第二树 37e3390），
业务字节逐字节一致——符合任务书预告，不为比较强改 buildTime。
第二树已清理。

## 7. 上轮主报告勘误（仅追加，原文未改）

在 `…/continuation-0002/treasury-integration-i-continuation-0002-report.md`
末尾追加「勘误（2026-09-10 增补）」：①收尾时 `enabled.ts` 实际为 false
（f8b3a26 恢复，最终 HEAD 77d67d6 默认关闭成立；报告 L137-139 描述的是
cf29a69 时点）；②C02 独立 CLI 校准原件 repoHead 为 4fb23e6（绑定配置前），
正式窗口内的是正式 run 中重新执行的 C02 预检。历史成功/失败身份不变。

## 8. 最终五问（AGENT-VERIFY 末段要求分别回答）

1. **新增观察器离线验收是否通过**：通过。原样首轮（54 Node + 2 套 13 例
   Jest + tsc×2）与独立反例（17/17）、完整回归（248/248、1539/1539）、
   预算校验（PASSED）、第二树定向复验（30/30）全绿。
2. **实际 facade 下是否发现写入或隐藏查询副作用**：未发现。观察器仅经
   `Pick<TreasuryService>` 五个只读端口读取；八个写端口 spy 零调用；
   作者 Jest 的 Memory 只读 Proxy 记录零尝试写入；刻意不调
   `getTerminalActionClaims()`（其过期 claim 同步删除属写行为）；
   query 固定 `withhold:0`、无 owner 豁免、非具体动作 policy 授权
   （report 恒 `authorizesActions:false`、`strategyPolicyEvaluated:false`）。
3. **完整 main 是否保持原行为顺序**：保持。phase 表 41→42 仅在
   treasuryShadow 后、treasuryEndTick 前插入 `treasuryReadOnly` 一个诊断
   phase；原 6 个 main 测试用例原样保留全绿；观察器异常自含
   （fault 后停用自身、不阻 endTick/flush），业务 fail-fast 不变
   （作者 Node 用例 + main Jest 复证）。
4. **默认是否关闭**：是。三重证据——源码 `enabled:false` + 空 shard/rooms
   （且空 rooms 在开启时 invalid_config 永久锁，不解释为全帝国）；bundle
   内配置原样（enabled:false）；生产装配运行级零输出测试。
5. **真实 CPU/正式数据是否仍未验证**：是，仍未验证。CPU 边界为协作式
   （测试用注入的 CPU 读数验证），无真实引擎 CPU 占用测量；无线上代码/
   Memory/房间核对；线上版本与本分支差异未核对（当前线上若未含整个国库
   重构，不能称"只是上传只读功能所以没有其他行为变化"）。

## 9. 状态与边界

**READ_ONLY_CODE_VERIFIED / NOT_DEPLOYED。**

- 启用/部署/线上核对/只读采样安排是后续单独任务，本验收不自动启动。
- PASS 仅指离线代码与测试语义；不构成对生产替换、并发物流、市场或
  故障恢复的背书。
- 环境未连接任何游戏服务；SCREEPS_TOKEN（gitignored .env）未进入任何
  提交。

## 10. 证据索引

- `01-apply/`：zip 原件、apply-record.log（含锚点保护拒绝实录）、
  package-payload/（manifest、changes.patch、provenance、交付端 validation 原件）
- `02-first-round/`：node-local-spec.log、tsc.log、first-jest.json
- `03-independent/`：independent-jest.json（17/17）
- `04-full-regression/`：build.log（含 bundle 默认关闭证明）、jest-full.json、
  verify-jest-budget.log、frozen-diff.log
- `05-second-tree/`：npm-ci.log、second-jest.json、second-validation.log
- `independent-acceptance.md`：独立验收 subagent 判读记录
