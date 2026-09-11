# 固定基线与来源记录

任务包制作日期：2026-09-11。

## GitHub 分支

- `refactor/empire-treasury-rearchitecture`
  - HEAD：`f4204c2b4c0bc3637ac0347e8d87b23d516bb934`
  - 最新提交为线上观察报告时间线勘误；完整 Treasury 生产装配仍包含 `beginTick`、旧业务阶段、只读观察与 `endTick`。
- `compat/treasury-read-bridge-i`
  - HEAD：`91532745123ca14cddb78385f9a88800fca4bf1a`
  - `src/runtime/treasuryCompatConfig.ts` 已恢复默认 OFF。
- 旧生产源基线：`06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c`。

## 上一轮线上结论

证据报告：

```text
openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/
online-observation-0001-tooling-remediation-i/REPORT.md
```

终态：

```text
ONLINE_COMPAT_READ_INCONCLUSIVE / RESTORED
```

已证实：

- 唯一候选 POST 被服务器接受并完成回读；
- 候选部署身份帧出现；
- 首个采样点 `S=73624800` 前 collector 退出；
- 桥样本为 0；
- guard 以 `collector_stalled` 关闭；
- 精确恢复和恢复后旧主循环运行有证据。

未证实：

- 兼容桥在线样本等价性；
- collector 退出根因；
- 完整窗口稳定采集；
- 完整 Treasury 生产切换。

## 补丁基底

补丁从 `f4204c2…` 的上一轮工具归档路径提取 17 个固定 Git blob。详细列表见 `PATCH-BASE.json`。历史 evidence 不原地修改。
