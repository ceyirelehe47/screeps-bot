# 补丁镜像

运行文件已经完整包含在包中，Agent直接执行包内工具，不必应用这些镜像。

三份补丁用于从空的、工作树外目录独立重构 runtime、tools、tests 和 references。不要把它们应用到生产仓库，不要用它们开启配置。生产配置仅由 tools/observe.cjs 即时绑定并在末尾精确关闭。

补丁使用Git的new-file diff生成，制作方顺序执行apply --check/apply并逐文件比较。没有单空格空上下文豁免，也不包含旧实验补丁。
