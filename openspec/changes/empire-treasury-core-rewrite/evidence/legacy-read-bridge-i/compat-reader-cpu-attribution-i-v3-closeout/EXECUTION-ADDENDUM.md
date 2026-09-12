# Compat Reader CPU I · v3 归档收尾补充

沿用 compat 源码提交 43b1b8e51caca0c17b975971a71fbbb0951823bf，父提交 3292e152b0db465263e4f1fa5c9eac068394acef。
refactor evidence 父提交固定为 0b09414f90c7144bbff61758fe7cf605576231e7。

本轮不重新应用 CPU 源码，不创建第二个 compat 提交，不重跑已留存的 91 项、70 项、195/685、十场景 A/B 或构建。复用的前提是提交、固定包身份、原始退出码和证据字节全部核验一致。

v2 步骤17的逐字节归档要求与步骤18的无例外 whitespace 检查冲突。原生 git diff --cached --check 仍为 exit 2，不得改写为原生检查通过。
唯一例外：openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-reader-cpu-attribution-i-v2/task-package/patches/0001-reader-cpu-accounting.patch 的第73、78行；整个文件 SHA-256 5067582c5e52de06c1bb1fac0126b9e6e65e483ec9bc8b0d09eca8ec0d5e5067。两行均为 unified diff hunk 中的单空格空上下文，不是生产源文件中的尾随空格。

新门禁先验证该整个固定文件及 hunk 语法，再要求原生完整检查的诊断恰好只有这两处；只排除这一个精确路径进行剩余文件检查，剩余文件必须零诊断、exit 0。没有排除全部 .patch，也没有修改 Git 配置、签名或钩子。

原77文件 fingerprint：a9c0e511ac3940d4c8ba53c5dc44348e7b5855b10d1c1b1f3f5dc4b456a9df38。这些文件保留原始字节，包括旧任务书与旧失败规则；本补充是后续授权，不追改旧包。旧步骤18失败 stdout/stderr/exit 继续保留在 Agent Git 外工作目录。

新增补充记录中的原始检查输出用 JSON 转义无损保存，避免把诊断文本自身的行尾空格再次引入新文件。

范围仍为默认 OFF、预算2、不使用 token、不连接 Screeps、不上传候选、不执行恢复、不启动0004。引擎CPU缺口仍未解决；原0003仍为1条raw/0条完整，恢复闭合事实不变。

本文件在提交前装配，不声称推送已完成；只有最终 staged gate、唯一 evidence 提交和两条远端普通推送回读全部通过后，才允许报告本轮最终成功。
