# Terminal Transfer Slice 0 — 来源契约、原型接线与实验准备

任务身份：**Terminal Transfer Slice 0**（验收索引 M01–M08；任务书 `treasury-terminal-transfer-slice-0-implementation.md`，SHA-256 `1d1d835376fb95b5c897511070024085f971b578ab7d05efd96daf15ad6f55f5`）。承接 Evidence Remediation I（`1b1279f`）。

本文集中放：§1 固定源码契约短报告（M02）、§2 原型接线与适配差异（M03–M07 的实现依据）、§3 后续隔离引擎实验说明（M08，只准备不执行）。

> **Lab Prep I 更新（2026-09-08）**：§3 的隔离实验准备已落地为可构建探针包——见 `terminal-transfer-engine-lab-prep-i.md`（observer/single-shot 双入口、离线自测、待测矩阵与停止清理；PREPARED_NOT_RUN）。本文 §2 的接线细节以 Remediation I/II 当前实现为准。

---

## 1. 来源契约短报告（M02）

### 1.1 读取的来源与版本

| 来源 | 版本锚定 | 关键路径 |
| --- | --- | --- |
| 官方 API 文档 | 访问日期 2026-09-07 | `docs.screeps.com/api/#StructureTerminal.send`、`#Game.market.outgoingTransactions`、`#Game.market.incomingTransactions`、`game-loop.html` |
| 开源 engine | 提交 `80977824199a596d174d392fd0cf8c458c21fcbd`（主题 4.3.2）——**可复核基准，不冒充正式服版本** | `src/game/structures.js`（StructureTerminal.prototype.send，L714–745）、`src/processor/intents/terminal/send.js`（L6–33）、`src/processor/global-intents/market.js`（executeTransfer L15–69；send 分支 L71–95）、`src/game/market.js`（交易视图 L203–233）、`src/utils.js`（calcRoomsDistance L644–655、calcTerminalEnergyCost L657–659）、`src/main.js`（主循环阶段）、`src/runner.js`（用户 tick 保存 L15–50） |
| 开源 driver | `screeps/driver` master `cf63d8adf902663e2ebddd7f8c5b7baa425dc928`（访问日期同上） | `lib/runtime/runtime.js`（用户代码结束→Memory 序列化→单一 outMessage）、`lib/index.js`（saveUserMemory L153–159，>2 MB 拒绝保存） |

源码原文已按上表 SHA 于实施时逐文件核对（下载副本存 `evidence/terminal-transfer-slice-0/sources/`，含 SHA-256）。未逐字核对的部分（见 §1.4）不以源码事实的口吻引用。

### 1.2 源码事实（每条均有固定 SHA 行号依据）

**API 层（send 入口，structures.js L714–745）**——同步检查链，任一失败立即返回错误码、不写 intent：`ERR_NOT_OWNER`（非自有）→ `ERR_RCL_NOT_ENOUGH` → `ERR_INVALID_ARGS`（目标房间名格式/资源类型/description 非 string 或 >100 字符）→ `ERR_NOT_ENOUGH_RESOURCES`（源 `store[resource] < amount`；费用能源：货物为 H 时查 `energy < cost`，货物为 energy 时查 `energy < amount + cost`）→ `ERR_TIRED`（cooldown 中）→ `ERR_NOT_ENOUGH_RESOURCES`（费用）。全部通过：`intents.set(this.id,'send',{…})` 并返回 `OK`。**OK 只表示本 tick 的 intent 已收集，不是世界效果确认。**

**处理层（intents/terminal/send.js L6–33）**——用户 tick 结束后重查：房间名格式、资源类型、`store[resourceType] >= amount`、费用（含 `PWR_OPERATE_TERMINAL` 折扣），全部通过才 `bulk.update(object,{send:intent})` 把 intent 挂到 terminal 对象；**任一失败静默 `return`——无任何记录**。

**世界层（global-intents/market.js）**——send 分支（L71–95）：先清 `send` 字段；冷却中（L77）或目标房间无 owned terminal（L80）→ 丢弃（无记录）。`executeTransfer`（L15–69）：

1. 任一结构缺失 / 源库存不足 → `false`（无记录）；
2. **目标为 user terminal 时 `amount = Math.min(amount, freeSpace)`——按缩量后的实际量继续**（L25–29）；
3. 缩量后 `amount ≤ 0` → `return`（undefined，无记录、不设冷却，L30–32）；
4. 费用按**缩量后 amount** 重算（L34–35）；费用不足 → `false`（无记录）；
5. 通过：目标 `+amount`、源 `-amount`、费用端 `-transferCost`（三处 bulk 更新），`bulkTransactions.insert({time:+gameTime, sender, recipient, resourceType, amount:实际量, from, to, description(< 转义为 &lt;)})`，返回 `true` → 设置冷却（`C.TERMINAL_COOLDOWN`，常量值在 driver constants，文档值为 10 tick）。

**交易视图（game/market.js L203–233）**——`incomingTransactions`/`outgoingTransactions` 惰性 getter；字段：`transactionId`（内部 `_id` 字符串化）、`time`、`sender`/`recipient`（`{username}`）、`resourceType`、`amount`、`from`、`to`、`description`；deal 路径记录另有 `order` 字段。两视图按用户视角过滤**同一底层记录**（同 `_id`）——同一交易在双方视图出现是同一条事实。历史窗口有限（文档明示 limited history）。

**费用与距离（utils.js L644–659）**——`calcRoomsDistance(continuous)`：房间名坐标差的环形取短 `max(dx,dy)`；`calcTerminalEnergyCost = Math.ceil(amount * (1 - Math.exp(-range / 30)))`。

**执行时点（main.js 主循环）**——用户 tick 全部完成 → 房间处理（处理层在此）→ `commitDbBulk` → global 阶段（世界层 executeTransfer 在此）→ `commitDbBulk` → `incrementGameTime`。**send 的库存变化与交易记录在 tick T 后期产生，对用户脚本最早在 tick T+1 可见。**

**runner／driver 保存边界（engine/src/runner.js L15–50、driver lib/runtime/runtime.js、lib/index.js L153–159）**——用户代码（含 intent 收集与 Memory 修改）结束后组装**单一结果对象**（memory/memorySegments/intents/console/error）；`saveResult` 中 `saveUserMemory` 与 `saveUserIntents` 以并行 promise 发起（`q.all`）——**源码层面 Memory 保存与 intent 提交无先后保证**；Memory >2 MB 时 `saveUserMemory` 拒绝保存（保存失败路径存在）。

### 1.3 任务书五个重点问题的回答

1. **OK 时知道了什么；何时看到最终效果与记录。** OK=API 层检查全过且 intent 已入收集容器。效果（双方库存、费用、冷却）与交易记录最早 tick T+1 的脚本可见（§1.2 执行时点）。同 tick 内 read-back 到的 Memory 只是用户进程内的对象状态。
2. **全量／部分／处理未完成如何区分。** 全量=唯一匹配交易记录 `amount === 请求量` 且库存终态与提交前基线吻合；部分=记录 `amount < 请求量`（executeTransfer 缩量事实，记录仍插入）；处理未完成=无记录（静默丢弃路径多条）。未知返回／读取异常一律保守 unknown，不折算为全额成功。
3. **如何把一条实际读取的交易记录关联到 attempt。** canonical description 内固定安全 ASCII 关联键（`treasury-slice0 <key>`，≤100 字符），同一值进 durable facts；对账匹配 description+from/to+resourceType+amount、排除带 `order` 字段的市场记录与他人/旧请求记录。**游戏 transactionId ≠ Treasury `tk1_` attemptId**——关联只经关联键与公开字段，不用金额/房间单字段比对。
4. **查询不到交易为何不能证明未执行。** 历史窗口有限（被挤出）、读取可能不全、静默丢弃路径本身无记录——三者都呈现"无记录"。责任因此保留（still_uncertain），本 slice 不用 TTL 删除、不自动结案。
5. **kernel 调用边界／观察覆盖与延迟生效需要实测的位置。** 本内核观察以受控世界序/tick 推进；真实引擎效果固定在 T+1 可见——观察锚定必须"记录 time < 当前 tick 且库存核对一致"，不能以观察序号增大推断效果已覆盖（§4.4 明令）。**Memory 对象 read-back ≠ driver 已持久化**（runner 并行保存、>2 MB 拒绝、崩溃时点——见 §1.4 与 §3）。

### 1.4 原型假设（非源码事实，仅离线模型内成立）

- 受控世界尺寸 128（费用距离环形取短用；正式服尺寸未核对）；冷却 10 tick 取文档值（常量定义在 driver constants，未逐字核对）；两房同一测试用户；交易视图窗口/异常行为是测试配置的模拟；fake submit／processPendingRequests 是离线模型，不是任何真实引擎执行。

### 1.5 仍待真实实验回答（不可由源码/离线模型证明）

- 正式服 engine/driver 与固定 SHA 的实际差异（含交易历史窗口大小、市场记录到达时延）；
- `saveUserMemory` 与 `saveUserIntents` 并行保存在一侧失败/进程中断时的实际持久化组合（runner 源码只能证明"并行发起"）；
- CPU 超限中断在用户代码中段发生时，已执行的 `terminal.send()` 调用与部分 Memory 修改的实际留存组合；
- global reset（heap 丢失、Memory 保留）后交易视图与冷却状态的真实可见性；
- `PWR_OPERATE_TERMINAL` 折扣与多人目标的部分转运组合（本 slice 不支持 Power 与多人，但真实环境会遇到）。

---

## 2. 原型接线与适配差异（M03–M07 的实现依据）

### 2.1 组件与装配边界

| 组件 | 位置 | 说明 |
| --- | --- | --- |
| fake 宿主 + adapter 原型 | `test/mock/treasuryTerminalTransferPrototype.ts` | 仅测试目录；不进 Jest 收集、不进生产 bundle；注册只经 `replaceTreasuryActionAdapterForTest`（M03 断言默认注册表无此 kind；生产 `actionContracts.ts` 零改动） |
| 行为验收 | `src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts` | M03×1 + M04×2 + M05×1 + M06×2 + M07×2 共 8 it |
| 核验驱动 | `scripts/verify-treasury-evidence.mjs` | 工作 A 收尾（M01）；整合上轮三个后置 .mjs 的现有调用，expected 改用固定夹具约束（H18：20 unknown/12 观察窗口） |

宿主三段建模与源码对应：`submitTerminalSend`（API 层检查链+pending 化）、`processPendingRequests`（处理层重查+世界层缩量/静默丢弃/插记录）、`transactionsView`（公开形态记录视图）。宿主可变状态（pending/transactions/submits/报价/冷却）全部在工厂闭包——跨 `performTreasuryFullReset` 存活；断点配对经 `captureBranch()`（复用 harness `treasury-journal-branch` 形状，reopen 恢复宿主副本），adapter 暴露 `journal = host` 使恢复装配的来源关联核实（Remediation IV/V2 §4.2）按既有协议通过。

### 2.2 关键设计决定

- **`settlesOnAccept=false`、`nonOkOutcome="unknown"`**：OK 只是调度（§1.2）；不新增返回协议。
- **单一参数来源**：canonical args（源/目标房间、资源="H"、amount=100、关联键）派生三腿 postings（源 −100H、源 −fee energy、目标 +100H 接收空间）、三个结构绑定（source/fee_source/target）与 durable facts；fee 从可信报价端口派生并冻结，执行时端口内比对——漂移（报价上行）拒绝继续调用（`ERR_FEE_QUOTE_DRIFTED`）。
- **durable facts**：受控编码 `k:<key>|a:<amount>|f:<fee>|sb:<源H,源energy>|tb:<目标H>`（kernel payload 字符集排除 `"` 与 `\`，JSON.stringify 不可用）——提交前库存基线进持久事实，reconcile 的终态核对锚点。
- **reconcile 只接收公开形态证据**：交易视图端口（可配置窗口/异常/注入，模拟有限历史）+ `Game.rooms` 世界读取 + facts 基线；不读宿主 pending/submits 内部状态。**永不返回 `observed_not_executed`**——源码事实是静默丢弃路径无记录，查询不到不能证明未执行。部分量（唯一记录 `amount < 请求`）保持 still_uncertain：不补发、不重执行、不丢弃剩余责任。
- **同 workKey 排他**从持久 active 记录读出（kernel `sameWorkKeyActive`）——断点重载后"未知时第二需求阻断"跨 reset 成立（M07b）；恢复后新接纳必须经**新模块**的 `buildTreasuryActionContract`（resetModules 后旧模块入口的 contract 注册对新 service 无效——测试 `admitRestored` 注释记录了这一边界）。

### 2.3 适配差异与 ADAPTER_GAP 结论

- **无 ADAPTER_GAP**：现有接口（adapter 协议 + settleUnknownOutcome + 配对断点 reset）足以表达本业务全部必要事实，本轮没有保留最小反例。
- 已识别、如实记录的差异：① 观察锚定以"记录 time < 当前 tick + 库存基线核对"承担——真实引擎的可见时点本身待实测（§1.5）；② 关联键唯一性范围=本隔离测试 run（夹具控制）；若用于真实环境需说明跨 reset 不复用的来源与 actual attempt 绑定方式，无法成立时列为适配前置条件（本 slice 不宣称随机串天然唯一）；③ 用户可见 description 不是签名、关联键不是权限（无鉴权语义）。
- 旧同步生效模型（内置 `test.transfer`，`settlesOnAccept:true`）与延迟模型并存：后者只在新 mock 表达，不改前者（历史测试继续用同步模型）。

---

## 3. 后续隔离引擎实验说明（M08——只准备，不执行）

**授权边界：本节是计划文本。任何真实实例创建、游戏代码上传或真实 API 调用均待单独授权；本轮不部署、不 `npm run push`/`npm run local`、不接真实 writer。**

1. **一次性隔离环境与版本锁定**：新建合成账户+新世界（不用正式账号/PTR/现有私服/玩家 Memory 或凭证）；锁定方法：私服按开源 engine/driver 固定 SHA（§1.1 两 SHA）安装并在实验记录中存 `git rev-parse HEAD` 与启动参数；正式服不可锁版本——若做正式服实验须声明"版本未锁定"并只引用文档事实。
2. **实验动作面**：仅一条单向 100 H 调拨（本 slice 场景），无其他经济 writer（无 market/lab/factory/nuker）；Bot 代码仅包含观察与记录逻辑（terminal.send 一次）。
3. **观察项**：tick T 调用返回码与当 tick Memory read-back；tick T+1、T+2…两端 terminal 存量、energy（费用）、cooldown、`outgoingTransactions`/`incomingTransactions` 记录（含 transactionId/time/amount/description）。
4. **分场景所需证据**：
   - 全额成功：两端存量精确变化（−100H/−fee/+100H）+唯一记录 amount=100；
   - 即时拒绝（构造源不足/费用不足/冷却）：返回码 + 零记录 + 零库存变化；
   - 目标空间变化（构造目标近满）：**部分转运是否真实发生与实际 amount**（executeTransfer 缩量的实机验证）；
   - global reset：强置 reset 后 Memory/交易视图/冷却的真实留存；
   - CPU 终止：在 send 调用后注入超限（受控手段）观察 intent 与 Memory 的实际持久化组合——**真实 driver 窗口未知处写待测，不得以 Node throw 或本 slice fake 代替**。
5. **关停与恢复**：实验后立即移除 terminal.send 调用并上传观察-only 代码；存量差异在实验记录中登记自然回流（不做人为平衡）；隔离环境用后销毁。

---

## 4. 验收索引（M01–M08 → 实现位置）

| 编号 | 承担位置 |
| --- | --- |
| M01 | `scripts/verify-treasury-evidence.mjs` + `evidence/terminal-transfer-slice-0/final/`（自测三组实跑：正例/缺输入/坏内容）与主验证 `verify-evidence` 步 |
| M02 | 本文 §1（四列区分：源码事实/官方文档/原型假设/待实测） |
| M03 | 测试 it「M03」+ 主验证 production/config freeze 零差异 |
| M04 | 测试 it「M04」×2 |
| M05 | 测试 it「M05」 |
| M06 | 测试 it「M06」×2 |
| M07 | 测试 it「M07」×2（提交后结果持久化前 + 已接受未处理） |
| M08 | 主验证（固定 SHA）+ 第二上下文定向复验 + 本文 §3 实验说明 |
