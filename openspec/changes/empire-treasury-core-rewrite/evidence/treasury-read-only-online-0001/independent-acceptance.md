# 独立验收 — Treasury Read-only Observation I · 线上基线核对与限定采样 0001（阶段A）

日期：2026-09-10 · 验收方：独立只读 subagent（与执行方分离）· 方式：从原始证据独立重算/实测，不复述报告

## 总判定：支持 `ONLINE_BASELINE_REVIEWED / NOT_DEPLOYED`

核心声明链经独立实测全部成立：

- **A 起点与授权纪律 PASS**：HEAD=828a078 树净、origin 一致；两个仓库外薄脚本审查为纯 GET（与仓库 screeps-api 客户端同款头），无 POST/console 注入/Memory 写路径；noratelimit 链接仅存在于脱敏 429 响应体、无调用痕迹；用户既有监控仍活跃（验收时 collect-canary3.log mtime 持续推进）。
- **B 线上身份证据链 PASS**：仓库外备份 a2-modules/main 实测 sha256/bytes 与摘要一致，且与 API 响应 modules.main 逐字节相等；独立重算 computeModulesHash 集合摘要一致；git show %T 与内嵌 BUILD_TREE 完全一致；default 唯一 activeWorld；username=forster。
- **C 差异判定 PASS**：rev-list 实测 432；diff 文件总数 3120 与分类总和吻合；抽查 resourceControl/defenseFocusFire/runtime.d.ts 在差异内、根 package.json/rollup.config.js 不在；「差异表第 3 行命中→停止部署+授权未取得」推理符合任务书 §4/§2.3，是明文合法出口 1。
- **D 状态旁证 PASS**：快照三要素与 canary3.jsonl 末行完全一致；429 原样标缺失未伪造；treasuryCore 不存在未填 0；「旧代码身份」三重印证自洽。
- **E 敏感信息 PASS**：8 位 token 前缀（429 响应体内出现者）证据树 0 命中；无 36 位 token 形态；.env/.secret.json 值未出现。
- **F 四结论一致性 PASS**：四结论逐项有证据支撑、无夸大；B/C 阶段无空材料；磁盘 dist 身份（sha/BUILD_COMMIT/mtime）证实本轮未构建，符合 §9.3。
- **G docs/tasks PASS**：两处均为纯追加，历史原件零改动。

## 问题清单与处置（全部非阻断）

| # | 问题 | 处置（本轮完成） |
| --- | --- | --- |
| P1 | 主报告 §3「线性提交/本轮仅有前者」使用完成时态，落笔时提交尚未发生 | 已改写为收尾纪律声明并注明「报告落笔时提交尚未发生」；实际提交/推送见本轮 git log（验收后执行） |
| P2 | 请求数不精确：三处写「GET×12、5×429」，实测 11 请求、6×429 | 已全部改为「GET×11（manifest 10：5×200+5×429；另有 1 次 429 重试首探）」 |
| P3 | monitor-deploy-evidence.txt 误将 rollback JSON 全文（8.6MB）复制入库 | 已重写为摘要+受控原件路径引用版（1.2KB）；原始数据未动，仍在 monitor-data/ |
| P4 | auth-me.json 含 email/steam 等个人字段 | 已脱敏（仅保留 ok/_id/username/cpu/gcl/resources 等解释兼容性所需字段） |
| P5 | diff-categories.txt「样例 40」实为全部 33 项 | 已更正标注 |

## 备注

- 验收方对 P3 的口径提醒被采纳：线上原模块与历史备份存受控本地（仓库外 monitor-data/ 与 incoming/ro-online-0001/），入库仅摘要与哈希——符合任务书 §9.2「只把已审阅无秘密、范围必要的证据提交仓库」。
- 判定依赖的独立重算项：模块 sha256/bytes、集合 hash、git tree/rev-list/diff 抽查、快照三要素、监控 mtime、脱敏后逐字节 diff、全树敏感 grep——全部由验收方亲自执行。
