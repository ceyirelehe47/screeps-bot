# CPU Recheck IV — Loader III Engine Recheck

完整实现交付包。基线 compat@ae15ec55b0363933d31c93acc2480b6adbea306a、refactor@33cfbd4e2192d65723cf3d9d85ae8cae8e8a06c0。以已离线验收的加载优化为唯一生产实现变化，复用CPU Diagnostic II已走通的四点执行/恢复链。

本包不包含等待Agent设计的实现。runtime为完整运行文件；tools含新基线检查、已提交加载器再生成检查、离线历史比较、归档与普通发布；tests为128项固定测试；patches是工作树外工具副本的完整镜像，不应用到compat生产源码。

保持2 CPU、100 tick间隔、E3N59/E4N58、energy/H、四点、5 CPU外部事后中止线与75秒独立恢复取证。绝对窗口仅在执行时绑定；临时ON/OFF是唯一允许的源码变更。正常结束后OFF tree回到新compat基线，不回到历史未优化代码。

任务书是 AGENT-RUN.md。先离线测试和真实仓库检查，再真实确认目标排他使用。制作方没有调用Screeps。故障时安全恢复优先，不能为重测删除一次性标记或停止恢复进程。

LOADER-COMPARISON.json使用精确历史裁决原件与当前原始run重新验证的结果。只统计实际发生的reader/observation/commitment调用，分开首次准入和首次加载。成本降低不是采集成功条件；较高、不变或样本不足都要如实保留。跨轮不是受控A/B，不计算因果提速百分比，也不将4个点当成12点正式兼容验收。

stdout/stderr/TAP按原字节摘要包装为JSON，补丁镜像由Git生成。原生暂存whitespace检查必须exit0，无例外。旧CPU II、Loader III证据均不改写。
