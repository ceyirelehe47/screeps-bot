# 独立验收 — 免限流解除与实时补齐增补轮（extension-rate-limit-0001）

日期：2026-09-10 · 验收方：独立只读 subagent · 方式：直读全部证据文件、仓库外受控原件（含 decoded 全量 Memory 与 3 脚本）、git 状态，实测数据与脱敏扫描

## 总判定：**支持本轮增补**

- **A 流程真实性 PASS**：解除前 429（remaining=0）原件与 manifest 吻合；verify-1（页面打开后仍 429）→ verify-2（Proceed 后 200）证据链成立，且有强旁证：`x-ratelimit-reset=1789061371` 固定下 verify-1 的 retry-after=10004 较 status 的 10105 恰差 ~101s——反推时间吻合且证明期间无其他 429 请求；200 响应 gz 解码 130,011B 与受控原件字节一致，"实际读取证实恢复"成立。
- **B 请求有界性 PASS**：6 次请求一一对应落盘产物（时间戳/tick 自洽：root tick 73614430 → rc-reread 73614479，差 49 tick ≈157s 与文件 mtime 吻合），无轮询痕迹。
- **C 敏感信息 PASS（本轮材料）**：证据 17 文件 + 3 脚本 + 受控目录，token 前 8 位 0 命中、36 位 token 0 命中（仅 git 部署身份 hash 合法命中）；open-noratelimit.mjs 复核确认 URL 不打印不落盘；证据与受控原件 md5 全一致。
- **D 实时 vs 快照 PASS**：部署标签与上轮在线字节/git 三方逐项一致；E4N58 两次读取 used 与 storageEnergy 同步 −3,898、used+free 恒 8,000,000、其余房恒 1,000,000（实测 decoded 原件）；PWR_OPERATE_STORAGE 归因有 powerCreeps 实证（homeRoom=E4N58）+ 用户澄清，非凭空断言。
- **E 零写边界 PASS**：三脚本纯 GET；无 POST/console 注入/Memory 写；NOT_DEPLOYED 维持；git 零代码变化。
- **F 文档一致性 PASS**：tasks/docs 与证据逐项吻合（空任务/空预留实测、E3N59 原生 H 实测、CPU/journal 数字实测）；"结构 ID 无法取得"三段论证全部核实（8 房 Memory.rooms.* 确仅 2 个杂项键）。

## 非阻断观察（3）与处置

| # | 观察 | 处置 |
| --- | --- | --- |
| ① | "2 小时有效期"为对话框文案的文字转述，无独立留痕（截图受"不暴露前缀"约束主动放弃） | 接受为单方记录；与官方已知交互一致；已在 summary 中标注来源性质 |
| ② | verify-1/2、rc-reread 为内联执行，脚本未预先归档 | 已按执行内容转录归档 `archived-inline-scripts.cjs`（标注"整理归档"性质） |
| ③ | verify-1.json 未入证据目录 | 已补入 |

## 移交级安全发现（非本轮引入，已应急处置）

`evidence/terminal-transfer-engine-lab-run-i-control-remediation-i/engine-continuation-0001/environment/s01-node-processes.json` 含**完整 token**，随提交 `7314277`（2026-09-10 00:55 +0800）进入已推送历史。执行方复核确认：历史 `-S` 全量扫描仅此一处；工作树唯一命中文件已在新提交中脱敏（`<REDACTED-TOKEN-36HEX>`）；**历史不可改写（已推送、禁 amend/force），唯一完全修复=轮换该 token**——已作为最高优先级事项报告用户。该发现与本轮增补无关（早 22 小时的其他任务遗留），本轮所有新增材料经扫描零暴露。

**事后闭合（2026-09-10 晚，用户会话）**：用户已轮换 token（新值仅写入 gitignored 的 `.env` 与 `.secret.json`，全仓扫描 0 命中，不入任何提交）；旧 token 经一次 `GET /api/auth/me` 实测 **HTTP 401 unauthorized**——历史泄露随之失效，本安全事件关闭。新 token 实测 HTTP 200（username=forster）。注：免限流 2 小时窗口属旧 token，新 token 默认受限流；长期运行的既有监控进程若持有旧 token 需重启后生效（未代为重启）。
