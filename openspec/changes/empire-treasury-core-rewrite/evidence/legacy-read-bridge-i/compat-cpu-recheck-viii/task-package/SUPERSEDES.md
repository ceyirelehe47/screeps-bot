# Supersedes / execution scope

本包用于 **CPU Recheck VIII**，取代任何把 Read V、Build VII 或 CPU Recheck VI 的绝对 tick 窗口直接复用到新实验的做法。

固定源码基线为 `compat@2d28a6f146fc81e5b87be7cf5b70648352557797`，证据父提交为 `refactor@a9f4cc04d99c8a8fda11f9c7e980861953341f03`。本包不重新应用 Build VII 源码补丁；生产工作树只允许临时修改 `src/runtime/treasuryCompatConfig.ts`，以 ON／OFF 两个线性提交完成一次四点实测。

历史对照固定为 CPU Recheck VI 的已验收裁决：Git blob `d1be370705d4bb3d1a0e522d0afc57f72f52f1f8`。Build VII 离线验收固定为 blob `f3e46cee63bfb3c42272a28a7d618bdf8e9f03d5`。两份原件均由前检从 Git 对象库重新读取并逐字节核验。

本包继承已验证的单层日志解码、四点采集、一次性写入标记、独立恢复进程和 75 秒恢复运行验证。没有重写线上安全算法。失败不授权增加第五点、换窗口补跑、提高预算、删除写入标记或现场修改实现。
