# 来源和动机

固定证据提交：04ca086c3d62db5f506389bc59c3fb1bb4b81b66。
目录：openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-cpu-recheck-vi。
EXECUTION-REPORT.md blob：2b3329cb99be132753d3ea32ed0083c02ef4a55f。

VI 已取得4条有效诊断，0完整业务样本，恢复已闭合。后续 readerLoad 区间约0.12—0.15 CPU；三个后续点实际构建commitment，但未产出四行完整投影。这些是既有证据事实，不是本包新实测。

本包据此转向实际构建。固定生成核心 fe94ebece8f5118b76701007ce3906adfbb4da08 中，task索引重复操作多张scope/room map；observation在已创建的数值快照上分配Object.entries二元组和临时房间对象。源码审查支持减少这些操作，但不支持预先宣布能满足2 CPU。

新包不复制完整VI run、不修改历史报告，也不将37条任务的合成计数场景冒充实际VI任务内容。保留完整输入校验和查询接口，工作量变化与引擎收益分开验收。
