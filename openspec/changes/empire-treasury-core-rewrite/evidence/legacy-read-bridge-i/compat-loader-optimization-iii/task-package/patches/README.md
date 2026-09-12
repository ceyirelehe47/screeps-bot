# Patch mirror

0001-loader-definition-reuse.patch 对固定compat基线的11路径提供完整变更，和implementation逐字节等价。生成时使用Git diff.suppressBlankEmpty=true；原生whitespace检查不需要例外。

推荐运行tools/run.cjs apply（带写前快照与回滚），而不是再执行一次git apply。补丁镜像用于审查和独立check/apply测试；不能在apply工具之后重复应用。

生成核心不是手工改其factory正文：scripts/build-treasury-compat-loader.cjs从固定baseline夹具和loader模板重建包装层；--check验证正文前缀、来源清单和生成结果。
