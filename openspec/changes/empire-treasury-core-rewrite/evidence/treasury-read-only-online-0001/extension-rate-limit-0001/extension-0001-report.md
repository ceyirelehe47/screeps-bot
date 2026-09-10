# 增补轮报告 — 官方免限流解除与实时字段补齐（0001-extension，2026-09-10 晚）

授权来源：用户会话指令（允许本地已有 token 走官方免限流流程；解除须以实际读取验证；只增加免限流操作与原任务范围内必要读取；不暴露 token 材料；不授权上传/切分支/改 Memory/发资源；不做无界轮询）。

## 结果一览

| 项 | 结果 |
| --- | --- |
| 免限流状态（解除前） | 仍受限：429、`x-ratelimit-remaining:0`、retry-after 10,105s；无公开 token 属性 API（/auth/tokens 404） |
| 官方解除流程 | 已登录 Chrome 打开官方链接（URL 由脚本运行时构造，未出现在任何输出）→ 确认对话框 → 点击 `Proceed`；仅打开页面不生效（实测仍 429） |
| 有效期 | **2 小时**（官方对话框明示 `Rate limiting will be turned off for 2 hours`，非永久开关） |
| 通路恢复确认 | `GET /user/memory` → **HTTP 200**（实际读取证实，非页面表象） |
| 本轮请求总量 | **6 次**（全部有界、一次完成，无轮询；窗口自然过期，未做反向开关） |

## 补齐的实时字段（取代上轮"未取得"标注）

1. **Memory.runtime 部署标签**：`lastDeployCommit=06ffedb7…`、tree/bundleHash/branch 全链与在线模块字节、git 历史三方一致——上轮缺失的 Memory 旁证现已闭合；`lastDeployAt=73346496`（≈10 天前，吻合 8-29 部署）。
2. **旧资源任务与预留（实时）**：`runtime.resourceReservations = {}`（零预留）、`data.resourceControl.tasks = {}`（零活跃任务）；`runtime.resourceControl` 活跃（updatedAt=当前 tick，8 房全 balanced/normal）。**上轮"未逐字段展开"的字段现已实时取得。**
3. **候选端点容量与库存（实时，8 房×storage/terminal 全表）**：见 `extension-summary.md` 表格；各房 minerals 含 H/O/U/L/K/Z/X；E3N59 为原生 H 房（未来观察 profile 候选）。
4. **E4N58 容量 8M 之谜已解**：PowerCreep 技能 `PWR_OPERATE_STORAGE` 生效（用户澄清 + 时间对照实证：49 tick 间 used 与 storageEnergy 同步漂移、used+free 恒 8M、其余 7 房恒 1M）。**迁移实现必须按"hub 房容量 1M↔8M 波动"建模，不得假设恒定。**
5. **其他**：cpuMonitor 实时 bucket 10000 满 / totalUsed 56.6/120；marketActionJournal 42 条、最新 ~38 天前（近期无市场动作）。

## 仍无法取得（只读接口，如实标注）

Storage/Terminal **结构 ID**：Memory 不缓存（`Memory.rooms.*` 仅杂项键）、REST 无房间对象接口、console 表达式注入不在授权内 → 留待未来部署窗口经合法途径取得或按 N/A 表达。Game 级实时对象（视野等）同此。

## 边界遵守

零上传/零分支切换/零 Memory 写/零资源发送；用户既有 canary3 监控未触碰；全部输出与入库文件经脱敏（`token=` 片段替换；token 前缀与含 token 链接零出现——含可访问性树读到的 UI 脱敏显示，仅以"8 位前缀-****"表述）。完整时间线与数据：`extension-summary.md`；原始响应与提取日志同目录。

## 对上轮结论的影响

不改变阶段A判定（线上=06ffedb、432 提交基础迁移、`ONLINE_BASELINE_REVIEWED / NOT_DEPLOYED` 维持）；本轮只是把"未取得的旁证字段"升级为实时事实，并为迁移实现包补充了两条硬口径（hub 容量波动、实时零预留/零任务的当前快照——迁移衔接设计可基于"当前无活跃旧任务/预留"这一时点事实，但仍须按非空场景设计）。
