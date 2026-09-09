# 已实现的测试小修与一次实机续测

本包基于 `5773f1a04be8cadebf6cf0b111149ddb2ae752e9`，仅修正一个测试文件。R01–R03运行实现不变；不是旧17文件实现包的重新发布，也不是新的国库实现任务。

把 `AGENT-CONTINUE.md` 与 `changes.patch` 一起交给测试Agent，继续已有S01–S06。本地没有启动实验世界、操作真实控制槽、终止真实进程、send或push。

## 内容

- `changes.patch`：唯一待应用增量。
- `modified-files/`：补丁后的单个文件，便于审查，不能绕过冲突检查覆盖仓库。
- `source-manifest.json`：固定基线、前后文件身份、补丁hash和本地验证范围。
- `AGENT-CONTINUE.md`：执行顺序、边界、验证合并安排和结果要求。
- `validation/`：原始定向输出、补丁检查、敏感性检查结果。敏感性检查的非零退出是预期地发现人为错误，不是交付实现未通过。
- `review-source/`、`test-before.cjs`、`check-test-sensitivity.py`：局部复现材料，不是完整仓库，不应复制到目标仓库中或当作游戏入口。

## 本地结果

相关Node测试20/20通过（其中包括independent6个）。修正没有增加用例数量：在既有最后一个测试内检查未武装与已武装两个方向，各自有单一变量反例和合法对照。

敏感性对照只在临时副本中进行：

| 被测变体 | 旧最后一项测试 | 修正后的最后一项测试 |
| --- | --- | --- |
| 原实现 | 通过 | 通过 |
| 删除armed比较 | 错误地通过 | 检测到变异，非零退出 |
| 强制拒绝所有控制样本 | 错误地通过 | 检测到变异，非零退出 |

这验证的是测试确实能区分保护失效与正常行为，不是发现当前运行实现存在这两种错误。

完整仓库Jest、正式编译构建与真实引擎未在这里执行。本地Node v22.16.0、全局TypeScript5.8.3；20个测试使用模拟I/O。再次尝试git访问的DNS失败记录也已保存。源码来自GitHub连接器和此前逐字节核对的交付包，关键依赖的Git blob匹配已记录。

## 局部复现

需要Node22、Python3和已安装的TypeScript。不要为运行本包连接游戏，也不要安装standalone。

在包内 `review-source/` 执行：

```bash
# 如果只有全局TypeScript，可显式给Node指定现有全局模块路径；不会安装依赖。
export NODE_PATH="$(npm root -g)"
node --test test/lab/terminal-transfer/tools/stop.spec.cjs \
  test/lab/terminal-transfer/tools/independent.spec.cjs
```

在包根运行 `python check-test-sensitivity.py` 可重建临时变异副本并重新保存诊断结果。该脚本只复制本包的局部源码，不接触目标仓库或游戏。归档需保持原件时，请先复制整包再执行，避免覆盖包内同名诊断输出。

Agent在真实仓库应用补丁时，请使用 `AGENT-CONTINUE.md` 的准确基线与 `git apply --check` 步骤，不使用 `review-source/` 全量替换。
