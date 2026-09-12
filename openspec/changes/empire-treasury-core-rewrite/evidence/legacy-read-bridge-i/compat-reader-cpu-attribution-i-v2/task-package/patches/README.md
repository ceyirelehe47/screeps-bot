# 固定补丁镜像

基线：compat@3292e152b0db465263e4f1fa5c9eac068394acef。

0001-reader-cpu-accounting.patch：三份CPU源码，与旧包补丁字节完全一致。
0002-repository-sandbox-import.patch：仅test/treasury-compat/helpers.cjs精确依赖映射。

干净基线按SERIES可重构implementation全部四个文件。实际任务必须走固定apply工具：识别旧三文件状态、先保存快照、再只写缺少的helper；不要在旧包已应用工作树中重复套0001。

补丁是完整实现的可审查镜像，不是要求Agent续写实现的设计说明。所有spec、Jest wrappers、项目测试预算保持原样。
