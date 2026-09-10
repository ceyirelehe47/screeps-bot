# Treasury Terminal Integration I · 代码应用与独立验收报告（lab-ti1-0001）

日期：2026-09-10 · 执行 Agent：ZCode · 判定：**离线交付全部达成；实机 LIVE_FAIL
（环境时序事故，零 send 调用，非任何被测代码缺陷）——TREASURY_INTEGRATION_PASS
不成立**。

## 三问先行（任务书 §6）

1. **有没有真正调用一次 `terminal.send`？——没有。** run-treasury 恢复后
   引擎主循环仍处滚动重启后的重置期，窗口零样本，`user_console_stalled`
   判停于任何业务代码执行之前；actions.jsonl 与 console.jsonl 中无任何
   send 边界事件。本轮唯一被消费的运行边界是 run 内的那一次恢复。
2. **是否观察到 100H 到账？——没有。** 窗口未开始，两端库存未变化
   （paused-snapshot：源 1000H/10000E、目标 2000E，与 fixture 完全一致，
   交易 0）。
3. **是否及时停止？——是。** 5 秒通道判停即时触发暂停（OK）；撤装写入
   tick 329 且 storage readback 确认（保留 attempted=false 事实）；
   终止路径 **terminated=true、7 PID 全部观察、3010ms、polls=1、
   auditErrors=[]**——本轮修复的停止工具首次在真实 run 内完整确认
   （对照 ec0001 轮的 PROCESS_STOP_UNCONFIRMED）。

## 判定表

| 阶段 | 结果 |
|---|---|
| 包完整性与原样应用 | PASS（zip sha256 45ad52f5…、patch 1a05f5a1…、baseHead=7314277 精确、17 文件输出哈希全匹配，apply_patch.py guard 全过） |
| 首轮检查 | PASS（npm ci Node 22.19.0/TS 5.9.3 锁定版；新 Node 117/117、旧工具 48/48、tsc×2 零输出、新 Jest 2 套件 11 用例） |
| 独立验收反例（§3.1） | PASS（自增 integrationAdversarial.test.ts 7 用例：同 ID 矛盾镜像/物理变化零交易/外实验 description/路线互换+时间错位/实扣超冻结报价不重试清除/缺武装三态零调用/结构替换——全部保持 outcome_unknown、committed 占用、单飞行边界、零世界序发布；真实 hook 计数器防"惰性 hook"假象） |
| Windows 停止 smoke（§3.2） | 首轮 FAIL→修复→PASS（详见下） |
| 构建与预算（§4） | PASS（禁用 bundle 35 源含生产 facade/kernel 全链、无 mock/singleShot/生产 main/Node 依赖；246/1515 全量真实收集、budget PASSED） |
| §5.1 环境与控制往返 | PASS（新一次性世界、fixture 后整树重启、24 样本基线 q=26 恒定、R01 完整闭环、两轮绑定提交） |
| §5.2 VALIDATION_HEAD | PASS（838dcc7：T=332=T0+3 首次固定、enabled=true；全量 246/1515 零失败、budget、CLI 55/55、冻结 diff 零差异、live bundle 482387B 且 dist 未触碰、第二树同 SHA 全绿且 bundle 逐字节 IDENTICAL） |
| §5.3 正式窗口 | **FAIL（环境事故）**：restart_interval=3600 滚动重启 runner/processor 撞上恢复时刻，主循环重置期无样本，5 秒通道判停；零 send、零观测；按 §5.3 纪律不改 ID/T、不 rearm，实验关闭 |

## 分项结果

### API（Terminal 裸通道）

无调用。恢复后世界停在 tick 329（重置期），无 `lab-send-attempt`/无
`lab-control-sample` 流入；外部收集器与工具订阅双通道均为空。控制槽终态：
`{experimentId: lab-ti1-0001, armed: false, stopped: true, attempted: false}`
（撤装保留未尝试事实；写入+readback 确认后引擎恰好推进一 tick 触发
memory-control 的保守 `world advanced after write` 失败——按设计不自动修复，
最终落盘状态因 taskkill 强杀不可考，如实记录）。

### 国库（Treasury facade/kernel）

零事件。live bundle 从未在 runner 内执行（主循环重置期新 runner 未接管
用户代码），无 admission、无 dispatch、无 kernel journal 记录。离线侧实际
kernel 链路已由 integration.test.ts（8）+ integrationAdversarial.test.ts（7）
+ tools.test.ts（3）在 VALIDATION_HEAD 与第二树全绿覆盖，包括 §3.1 全部
六条语义；但这些不构成实机国库 PASS。

### 工具（lab-control/process-scope 停止链）

- 停止修复（本轮真实缺陷，提交 3db0770）：Windows 上 Get-CimInstance 固有
  ~1.6s/次，原 4 次 OS 调用结构性超 4500ms（首轮两次失败原件已归档）。
  修复=tree 快照内含 root 的单查询 + 内核探活（`process.kill(pid,0)`，
  ESRCH 即退出实证）快路径；预算不变。smoke 修复后 10/10 PASS（含 conhost
  断言修正），真实 run 内 3010ms 全确认。
- 观察到一个未复现的间歇（1/19：CIM 返回缺字段行 → 安全方向抛错，不做
  查询自动重试；validateIdentity 错误消息已带 pid 便于定位）。
- run-treasury 的预检/订阅/恢复/判停/撤装/终止全链路行为符合工具承诺。

## 提交链（全部线性、未 amend/未 force）

| 提交 | 内容 |
|---|---|
| 92e0e50 | IMPL_HEAD：原样应用实现包 17 文件 |
| e2966f3 | 独立验收反例 integrationAdversarial.test.ts（7 用例） |
| 3db0770 | Windows 终止路径修复 + process.spec/smoke 同步（保留首轮失败证据） |
| 1a6c7a2 | 预算 243/1497→246/1515，锚点滚动 |
| 2d45e3c | lab-ti1-0001 第二轮绑定（q=26 实测回填 + 本轮 facts + 场景 G 演进） |
| 838dcc7 | VALIDATION_HEAD：T=332 固定 + enabled=true |
| （本次） | 证据归档 + 本报告 + 状态更新 |

基线 73142771a61… 的冻结核对：`git diff --exit-code 7314277..HEAD --
src package.json package-lock.json jest.config.cjs tsconfig.json
tsconfig.build.json rollup.config.js` 零差异。

## §5.3 失败根因（详见 formal-window/root-cause-restart-interval.md）

`.screepsrc restart_interval=3600`：launcher 仅对 runner/processor 传滚动
参数。正式树 11:21 启动、暂停 idle 等待离线验证，12:14 滚动重启 →
engine_main 主循环重置（waitForUsers/waitForRooms）→ 12:16 run-treasury
恢复落在重置期内 → 5 秒无 console 判停。无 Windows 崩溃事件、无用户代码
执行（live bundle 零运行）、processor 不跑用户代码也重启——排除被测代码
缺陷与本机 OOM。属本轮 Agent 环境运维失误（正式窗口前未核对滚动窗口）；
ec0001 轮未踩中纯属其树存活 <1 小时。

## 证据索引（openspec/.../terminal-transfer-treasury-integration-i/）

- `package/`：任务包原件（sha256 45ad52f553425206599509ad63a5e89dac236d9aed66d499ce7eb1645a4bf2e5）
- `first-round/`：原样应用首轮日志（npm ci/117/48/tsc×2/Jest）
- `windows-smoke/`：smoke 首轮失败两份原件 + 修复后 10 轮 + process.spec 演进
- `environment/`：安装/init/四次 launcher 日志/世界搭建（gen-room、fixture、
  terrain、spawn、open-room 全记录）/两次受控整树停止
- `baseline/`：24 样本原始 console jsonl + 解码器 + 汇总（tick 301–324、q=26）
- `control-roundtrip/`：inspect/initialize/observe-false/arm/observe-armed/facts
- `final-validation/`：VALIDATION_HEAD 全量验证（命令/退出码/输出/Jest JSON
  原件/budget/CLI/冻结 diff/dist 指纹/live+second bundle manifest）
- `formal-window/`：run-treasury 全部产物 + engine_main 日志 + 根因分析

工作区遗留（未入仓库）：D:\code\screeps\ti1-work（过程证据，已全部归档）、
lab-ti1-env（隔离环境，进程已全灭；目录清理见报告尾部）、
ti1-second-tree（第二工作树，已还原）、ti-bundle-disabled/ti1-bundle-live/
ti1-bundle-second（构建产物）。

## 边界声明

- 未连接线上服务器/PTR/既有私服/真实账号；未执行 npm run push/local；
  未合并 main；生产 src/根配置零改动（冻结 diff 证明）。
- enabled.ts 当前为 true——它随 VALIDATION_HEAD 提交，只对"装载该 bundle
  的世界"有意义；实验 lab-ti1-0001 已关闭，该状态不构成任何后续实验授权。
- 实机一次实验授权已消费（run 内一次恢复；send 零调用）。按任务书 §5.3
  不以新 ID/T/身份重试。再次实机须新任务书/新授权，且应携带本轮
  restart_interval 时序教训（正式窗口前重启引擎树或核对滚动窗口）。
