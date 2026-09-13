# Compat CPU Recheck VIII — Build VII Engine Recheck

完整实现交付，Agent 只负责核验、受控执行、归档和普通推送。固定起点：

```text
compat   2d28a6f146fc81e5b87be7cf5b70648352557797
refactor a9f4cc04d99c8a8fda11f9c7e980861953341f03
```

本轮不再修改 Build Optimization VII。它从已提交源码重新构建一个四点诊断候选，保持两房、`energy/H`、100 tick 间隔、`maxSampleCpu=2`，最多执行一次候选 POST 和一次恢复 POST，并在恢复后采集独立 75 秒运行证据。

`BUILD-COMPARISON.json` 以已验收的 CPU Recheck VI 为历史对照，分别记录 `readerLoad`、`observationBuild`、`commitmentBuild`、`directRead` 和序列化前总成本。只有 `calls=1` 的区间计入构建调用统计；成本降低不是采集通过门槛，也不生成因果提速百分比。

固定工具测试为 **176 项**；真实仓库门禁为五份 Node specs **200 项**、Jest **195 suites / 685 tests**、两套 TypeScript 检查、生成器复核及 Rollup build-only。上述层级存在包含关系，不能相加。

完整兼容十二点观察、预算提高、完整 Treasury 部署和市场／Terminal 动作均不在本轮授权范围。即使首次出现完整业务样本，也只说明本轮有限诊断取得进展。
