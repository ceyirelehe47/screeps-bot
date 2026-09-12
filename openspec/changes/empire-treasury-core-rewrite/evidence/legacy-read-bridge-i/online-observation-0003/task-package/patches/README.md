# 完整补丁镜像

三份补丁是runtime、tools、tests完整交付文件相对**空工具目录**的新增补丁，可按SERIES顺序git apply --check后应用；制作方已验证重构字节与完整文件树一致。

Agent正式执行优先直接使用ZIP中的完整文件树，不需要另行应用这些镜像。切勿将补丁应用到生产仓库根目录、旧toolkit或正在运行的目录。补丁不是Treasury生产源码的改造；唯一生产变化由固定配置binder/closer在合法compat工作树生成ON/OFF。

patch重构不包含README、任务书、references、验证记录和INTEGRITY，因此仅patch重构目录不能作为独立正式包通过精确包校验。使用完整ZIP作为可执行交付。
