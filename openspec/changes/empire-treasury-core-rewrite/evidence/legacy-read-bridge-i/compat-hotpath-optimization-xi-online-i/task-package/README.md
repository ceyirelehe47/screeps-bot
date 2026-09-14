# Hot-path Optimization XI + Online Recheck I

本包一次完成完整闭环：应用固定 XI 热路径优化、执行离线等价和真实仓库门禁、绑定新的四点窗口、复测九个 IX 子阶段、与上一轮逐阶段比较、恢复旧生产并归档推送。

XI 减少 observation、preview/direct 和 commitment 中已经定位的重复遍历、临时索引与重复目录读取，但不改变完整表校验、逐样本隔离、真实 Store 独立对拍、授权边界、默认 OFF 或 2 CPU 预算。包内包含完整 17 路径实现和 Git 补丁，Agent 不需要继续写代码。

固定起点：

```text
compat   9adb2739935c03c0450acfebbab94912a5e3e593
refactor 53cf8a6c07a171eeb8438c5cc07ac66d4968f1fc
```

固定在线范围仍为 E3N59/E4N58、energy/H、四点、100 tick、2 CPU。不追加第五点，不自动开启第二窗口，不把 `partial_cpu_budget` 冒充完整样本，也不以性能改善作为采集成功条件。
