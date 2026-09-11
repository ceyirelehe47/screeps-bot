# 补丁顺序与目标

补丁必须按 `SERIES` 顺序应用到 `materialize-base.cjs` 生成的工具根目录。

- `0001-collector-terminal-evidence.patch`
  - 新增安全诊断辅助；
  - 修改 collector/watch；
  - 增加文件式 collector 正常关闭。
- `0002-guard-classification-and-probe-verifier.patch`
  - 细分 heartbeat／collector 终态；
  - guard 使用具体 collector 退出原因；
  - 增加无上传稳定性探针验证器。
- `0003-tooling-regression-tests.patch`
  - 16 项 Node 测试及 fake WebSocket preload。

不要将补丁直接应用到历史 evidence 目录，也不要将工具补丁应用到兼容候选生产源码。
