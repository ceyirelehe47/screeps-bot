# negative-controls/ —— 隔离坏副本敏感性证据（Evidence Remediation I）

本轮负向控制是**测试侧**（expect 正常通过形态）：对原始记录集合与真实完整轨迹的隔离副本施加破坏，断言本轮核验/比较实现能准确定位；**不宣称生产已发生该类错误，不冒称生产漏洞**。生产侧负向变体（heap-only-gate/zero-advance）属 Seal I 历史结果（../core-candidate-seal-i/negative-controls/），本轮未新增生产故障模型。

## 产物清单

| 文件 | 内容 |
| --- | --- |
| ivkernel-sensitivity-from-jest-key.log | 主验证 jest-key 中 IVKernel PASS + H18-TRACE 摘录（敏感性 describe 5 it 随全套 17/17 绿） |
| negative-controls-t-isolated-known-behavior.log | `-t "敏感性"` 隔离运行记录：3 新 it 显式红（"前置 J06 未成功完成——无真实轨迹底版可用"）——敏感性 it 依赖 J06 定格的模块级真实轨迹存档（同文件顺序执行保证），隔离过滤下联动红是设计守卫（防 J06 失败时敏感性静默空转），非缺陷；全文件正常运行（final/jest-key.json）17/17 绿 |

## 变体与还原对照（全部在 IVKernel `Seal I／Evidence Remediation I 敏感性检查（K06/L01–L04）` describe 内持续回归）

- **原始记录隔离坏副本（L01）**：健康 H18 fixture 原始记录副本 delete invocation/external/outcomeEvidence（基线合法 null）与非 null 字段（invocationBoundary/identity/worstCase）delete、worstCase 单腿金额变化——经提取+JSON 往返+比较逐项定位 attempt+字段+存在性差异；还原对照=未修改记录集合与独立深复制均零差异。
- **真实轨迹隔离坏副本（L02/L03）**：J06 定格轨迹深拷贝上——风险证据整项 null（A）、实际快照金额漂移标签仍一致（B）、中间非空 riskDiff 终态正确（C）、快照缺一个 ID、post-close 漂移+终态标签一致、终态标签非空+post-close 一致、哨兵注入基线——核验器逐项拒绝且定位 seq/stage/attempt/字段；还原对照=未修改真实底版 problems=[]（原件经 JSON 比对未被变体触碰）。
- **落盘往返（L04）**：合法轨迹写文件读回仍过核验；哨兵经 JSON 落盘读回保留且被拒；B 型破坏副本落盘读回仍报差异；核验前后输入 JSON 不变（纯核验不自愈）。
- **无证据合成轨迹**：buildSyntheticSealTrace（检查点 unknownRisk=null、基线 2 字段）必须被报"风险证据缺失"+"缺风险字段"——不再冒充完整证据。
- 基线反例（修复前起点实现上同类破坏**漏报**的 6 红灯与 2 合法对照绿）见 ../baseline/——修复前后的同一断言对照证明修复有效且非"一律报错"。
