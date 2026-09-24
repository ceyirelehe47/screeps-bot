# FC1 Online II：已授权发布副本

用户在当前任务中回复“批准”，对应已展示的范围：将准备分支推送至正确 GitHub 仓库，并在即时基线核对通过后，对 `forster/default/shard1` 执行一次只读 FC1 测量；候选上传最多一次、四点各隔 100 tick、精确恢复最多一次，任何前置失败则零上传。授权记录见 [AUTHORIZATION.json](authorized-executor/AUTHORIZATION.json)。本记录不扩展到 G2 Treasury writer 灰度。

本次授权副本的完整性指纹是 `58e531ec76dbbbbb1d735a6885d28095fe1818de1c5de78d8a4f206043449606`。它保留现役巡逻源码 `5cef62c5` 的行为，恢复目标是 `main` SHA-256 `62a993bf917f1a74ef708584eaee1fc3d2deb5aaf8b0c751f8f9d72ff3c08032`，模块集合 hash `50295c19de66f7d34b2bd4e54f08317b212ea3a54054385a2abdeb6ef8aa74fe`。实际执行时仍须重新读回整个正式服模块集合；这里的早先快照不代替即时检查。

授权后重新封包并真实重跑：145/145 执行器分组测试、499/499 兼容源码 Node 测试、TypeScript 5.9.3 的两套类型检查、生成器与本地回放、195 suite / 688 Jest 测试及 build-only。结果见 [authorized-prepared](authorized-prepared/offline/result.json)、[执行器测试](authorized-prepared/executor-tests/result.json)；OFF 构建摘要见 [candidate-build.json](authorized-prepared/candidate-build.json)。ON 候选需要按线上选定 tick 重新绑定，不复用 OFF 字节。

正式 candidate/restore POST 与实验 marker 当前均为 0。发布副本位于 [authorized-executor](authorized-executor/)，原待授权副本和离线结果仍保留在同目录，未改写。
