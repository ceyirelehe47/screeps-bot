# Terminal Transfer Slice 0 · Remediation II 短报告

先归集后判全量、固定路线拒绝与 closing 投影验收（任务书
`treasury-terminal-transfer-slice-0-remediation-II-implementation.md`；
验收索引 O01–O06）。起点 `b938a15`（Remediation I 交付 HEAD），
持续生产冻结基线 `869149d`。本轮只处理三个剩余项：相关交易不能先按
全量过滤（A）、原型入口必须限定既定路线（B）、原记录仍 closing 时的国库
余额与容量断言（C 补验）。单条在途、冻结费用、基本交易身份核对、延迟
处理与恢复继续保留（O05）。

## 1. 基线与修复对照（起点 b938a15 隔离 worktree 实跑）

| 用例 | 起点行为（基线实测） | 修复后（退化对照实测） |
| --- | --- | --- |
| R-A：真实 100H 完成后注入同请求另一条 60H 记录（不同交易 ID、同描述/路线/双方/资源/时窗） | `settleUnknownOutcome` 返回 `ok`（误报 committed）——ownershipMatch 含 `amount===payload.a`，60 在唯一性检查前被过滤 | `still_uncertain`（O01 注册路径 a）——基线用例在修复树上转红 |
| R-A 对照：同链路无注入 | `ok` / committed（正确行为） | 保持 `ok`（O01 对照）——正确行为未破坏 |
| R-B：四间受管辖健康房间（A/B + C/D 资源充足）经业务协调器提交 C→D | `admitted` 并执行（submits=1）——sourceRoomName/targetRoomName 是可覆盖默认值，无路线拒绝规则 | `rejected`（stage=`route`）——基线用例在修复树上转红 |

基线原件与日志：`evidence/terminal-transfer-slice-0-remediation-ii/baseline/`
（3/3 passed；还原命令见 run-command.txt）。三类问题分开报告：A 为已运行过
函数级反例的实现缺口；B 为待仓库确认后实跑证实的入口缺口；C 为验收欠项
——实测通过（生产零改动），不预设生产缺陷，无 ADAPTER_GAP。

## 2. 工作 A：先归集相关事实，再判断是否唯一且全量

`test/mock/treasuryTerminalTransferPrototype.ts` 的 `reconcile()`：

- 相关性谓词 `relatedMatch`（原 `ownershipMatch`）：完整关联描述（确定编码
  严格相等）、期望路线（from/to）、交易双方（sender/recipient）、资源、
  send 类别（order 字段排除）——全部来自持久 payload v2。**实际 amount
  不是丢弃相关交易的条件。**
- 流程不变（两视图 → 按 ID 分组 → 相关副本一致性先验并归并 → 时点窗
  → 唯一性），在 `visible.length === 1` 之后新增 4b 全量完成条件：
  `matched.amount !== payload.a` → `still_uncertain`。
- 结果表（O02 实测）：唯一 100 正常完成；只有一条相关 60 拒绝（不补发、
  不报 not_executed）；不同 ID 100+60 任意顺序/跨视图拒绝；两个 100 或
  同 ID 100/60 矛盾拒绝；唯一 100 + 不同关联键的无关 60 正常完成；窗口
  内唯一 100 + 请求前历史记录语义保留（N02 既有回归不重写）。
- adapter 的 version/semanticIdentity 不变：改动是筛选顺序修正，reconcile
  的证据语义（公开形态 + 持久 payload 期望值）与既有 v2 契约一致，旧
  payload/旧身份不被解释为更强证明。

## 3. 工作 B：固定路线是拒绝规则

`test/mock/treasuryTerminalTransferCoordinator.ts` 的 `requestTransfer()`：
单条在途检查之后、准备之前新增固定路线检查——省略用 `W1N57→W10N57`；
显式同一路线接受；任一端点不同返回 `rejected`（stage=`route`，理由
"路线不在本场景范围"），不先准备、不构建、不接纳。常量更名
FIXED_SOURCE_ROOM/FIXED_TARGET_ROOM。运行时收到冲突路线不会静默改成默认
路线后宣告成功。通用 facade/kernel 多房间能力不变；低层夹具仍可用 C/D
经 facade 直连构造反例（入口边界同 Remediation I §5）。

## 4. 工作 C：closing 投影补验（实测通过，生产零改动）

新增 `projection()` 断言口径（M 文件 helper + O 文件 `queryRoom`）：
`service.query` 限定单房间 terminal、`allowProjected:false`、
`allowIncoming:false`、`subtractOutgoing:true`、`subtractReservations:true`、
`withhold:0`；目标容量用 `riskAdjustedFreeCapacity(B,"terminal")`
（`strictProjectedFreeCapacity` 不承担同一风险占用扣减职责，仅作对照说明）。

实测数字（默认夹具：源 1000H/10000E、目标 F0=100000、冻结费用 q）：

| 检查点 | observed | committed | spendable | 目标容量 |
| --- | --- | --- | --- | --- |
| unknown（提交后未处理） | 1000 / 10000 | 100 / q | 900 / 10000−q | F0−100（保守占用保留） |
| closing（settle ok 后、退出前） | 900 / 10000−q | **0 / 0** | 900 / 10000−q | F0−100（物理已扣、流入占用释放） |
| 退出后（原 cleanup） | 900 / 10000−q | 0 / 0 | 900 / 10000−q | F0−100（不重复释放） |

机制（生产代码只读核对）：closing-committed 的占用释放由共享锚点链
（invocation → external → invocationBoundary；occupancy.ts）与观察世界序
判定——效果进入适用观察后同一责任单次表达，不双扣；M05/M07 两种配对恢复
场景（提交后结果写回前、已接受未处理）同样通过（O04/§5.2）。

lifecycle 语义如实呈现：M07b 的断点捕获于 endTick 之后，恢复 tick 的授权
窗口已关（C06——已关窗口不得重开）→ `authorizationSafe=false` 且 blockers
恰为 `["lifecycle_closed"]`，但账目数字仍按真实占用计算（authorizable
不含 lifecycle，spendable 不是 fail-closed 的 0）——测试以精确 blockers
断言区分，不用 fail-closed 的数字冒充。

账目可用 ≠ 允许新调拨：closing 期间单条在途仍阻断 B（N03 既有语义，
O03 注明两条规则独立）。

## 5. O01–O06 索引

| 索引 | 承担用例（位置） | 结果 |
| --- | --- | --- |
| O01 | O 文件 it1（函数级两顺序 + 注册路径 a/b/c + 对照）；M06 部分量既有回归 | 通过 |
| O02 | O 文件 it2（函数级六场景 + 注册路径三场景）；N01/N02 既有回归保留 | 通过 |
| O03 | O 文件 it3（route 四拒 + 显式/默认 A→B 完整闭环 + 终态计数） | 通过 |
| O04 | O 文件 it4（unknown/closing/退出三段投影 + 物理终态）；M05/M07a/M07b 接入 | 通过 |
| O05 | M/N 既有单条在途、费用冻结与 submit 前 guard、身份/版本和 cwd 回归（主验证五组 + verify-evidence） | 主验证 |
| O06 | 固定 SHA 主验证 + 第二干净上下文定向复验 + 原始结果归档（evidence/） | 主验证 |

旧 N04 的"国库不双扣"声明由本轮 O04/M05/M07 实际核对补验。

## 6. 边界与不做

- 生产 kernel/facade/actionContracts/coverage/observation/testHarness/装配/
  配置/依赖/lockfile/Defense 零改动（主验证三组冻结 diff 承担）。
- 不新增协议/schema/持久字段/报价权威/持久锁/第二队列；硬限制（active 64、
  ring 128、JSON 360000、8 份/tick、成对预扣 2×4、8 消费者 12 腿）未触碰。
- 不部署、不上传游戏代码、不启动真实游戏服务器、不运行 npm run push/local、
  不调用真实 terminal.send()/Game.market.deal()；测试与核验离线。
- 沿留待办（低危）：O01 的函数级顺序变体目前覆盖 injected 列表两种排列，
  真实宿主记录与注入记录在视图拼接中的先后由 mock 固定（transactions 在
  前）——如需覆盖宿主记录在后的形态需扩展 mock 视图配置，本轮未做。
