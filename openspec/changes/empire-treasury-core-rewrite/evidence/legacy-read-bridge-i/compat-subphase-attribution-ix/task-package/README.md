# Compat Subphase Attribution IX

完整离线实现包。目标是在现有只读兼容桥中加入有界的 observation / commitment 子阶段归因，以便下一次在线诊断能够定位真实构建成本。

本包不连接 Screeps、不使用凭据、不修改采样预算、不启用配置，也不授权上传或恢复。默认配置保持 OFF，`maxSampleCpu=2`、绝对窗口为 0。

固定入口：

```text
node tools/run.cjs verify-package
node tools/run.cjs baseline ...
node tools/run.cjs test ...
node tools/run.cjs apply ...
node tools/run.cjs characterize ...
node tools/run.cjs full-check ...
```

Agent 必须按 `AGENT-RUN.md` 顺序执行，不现场补实现或放宽门禁。
