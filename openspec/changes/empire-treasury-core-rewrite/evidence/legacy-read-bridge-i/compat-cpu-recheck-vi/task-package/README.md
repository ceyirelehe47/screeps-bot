# Compat CPU Recheck VI — Read V Engine Recheck

完整实现交付，Agent只验证与受控执行。以compat@5080fda96418fefecfd8ddccc79a9649f6165bed、refactor@6891de86bd5bd7a2c896384965be1d2f070d087e为固定起点。

本轮不修改Read V实现。保持预算2、两房两资源、四点、100 tick间隔，使用新鲜前检绑定窗口；唯一候选POST、最多一次恢复POST，独立75秒恢复运行取证。正式十二点兼容观察及完整Treasury部署不在授权范围。

运行顺序和失败恢复只以AGENT-RUN.md为准。runtime/包含完整安全执行链，tools/包含离线检查、绑定、执行、验证、比较、归档和发布。patches/是本包实现镜像，不是要向生产仓库应用的源码改动；本轮仓库只临时改config ON/OFF。

READ-COMPARISON.json直接对照固定CPU IV验收原件；仅真实calls=1进入对应调用成本统计，明确区分索引完整性、结果投影行数与完整业务样本。性能提升不是通过门槛，也不计算精确因果提速百分比。索引complete且空rows不意味着零承诺。

固定测试152项（128项继承适配＋24项新增），仓库142项Node specs与Jest195/685分开统计。工具测试等待上限15分钟不改变任何线上安全时间线。模拟输入和已提交历史验收不是新引擎测量。

制作方环境和验证边界见validation/LIMITATIONS.md。使用全新Git外目录；保留旧包、私有快照与原始日志，不覆盖旧实验。
