# v1 停用；v2 仓库测试集成修复

旧包：screeps-compat-reader-cpu-I-2026-09-12.zip
SHA-256：e15b7c5ff0480dbf91ac7f96928380742a4ab30b2bd136a15012f97bad153978

用户提供的Agent报告说明：69项与10场景A/B通过，真实仓库全量检查因两个Jest包装suite中的Node测试无法解析新增CPU值导入而失败；没有提交或推送。该报告不是完整实现成功证明。

制作方重新读取固定Git helper（238caabe0de507c9c026c594290d8e7bfeeca337）与bridge spec（8061a074218ba8a9ce81ec15b5da6e4ad9aa1d83），逐字节核验后独立复现原导入故障。
修复落在helper，不删除断言、不改spec、不改Jest计数、不改CPU生产实现。只为精确父模块/导入名加载实际CPU模块；其他未知依赖仍失败。

另修正工具包自身的临时Git补丁测试：局部设置autocrlf=false/eol=lf。不再要求Agent屏蔽GLOBAL/SYSTEM配置，避免干扰真实提交身份或签名。

任务书允许并严格识别上轮已留下的三份未提交固定源码：保存外部原字节快照，应用时只补helper。任何未知编辑或已有暂存都拒绝，不reset、不丢弃旧失败现场。

固定基线没有变化：refactor@0b09414f90c7144bbff61758fe7cf605576231e7；compat@3292e152b0db465263e4f1fa5c9eac068394acef。
默认OFF、2 CPU、0 tick窗口、生成核心不变。旧0003恢复事实不变，观察仍不完整。v2没有授权线上运行。
