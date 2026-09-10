# 交付端验证范围

final-node.* 为最终54个局部Node用例；second-node.* 为补丁应用到第二份选定源码重建工作树后的同54例。不是独立机器、完整仓库或真实引擎。types.* 使用 TypeScript 5.8.3 与本目录选定声明，仅检查新3个模块。syntax-and-phase.* 为6个TS文件语法与main42阶段AST比较。

mutant-*.stdout.log 中的非零退出是预期：临时副本分别注入四种错误，测试均检出；变异实现未进入files或changes.patch。run-mutants.py可复跑，所有变异只发生于新临时目录。

initial-node.* 保留首轮2个失败；round2-node.* 为最初51例修正后的结果。此后增加3个边界用例，最终数量54。类型/主循环完整Jest/实际facade、bundle与线上测量仍须Agent执行。guard-wrong-baseline.* 为固定SHA保护拒绝重建假基线的反例；第二份重建树通过git apply --check/apply验证补丁本身，不冒充准确历史SHA工作树。

原样应用脚本的正确基线正例须在真实仓库由Agent执行。未运行任何服务、游戏或部署命令。git-access.* 保存当前Git检出的DNS失败；源码由GitHub连接器读取，两个原文件Git blob已经核对。
