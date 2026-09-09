# Control Remediation I：实验控制工具

这些文件只服务于一次性本机 Terminal 实验，不进入生产 bundle，不实现 Treasury 的授权或结算。`calibrationCheck.ts` 是本补丁唯一修改的既有实现；原有 main、observer、single-shot、sendGate、controlRecord 和原构建器均未修改。

## 验证状态

本实现交付时已经做了 Node 定向测试、实际 CLI 0/1/2 退出码测试和选定 TypeScript 文件的有限检查。尚未在完整仓库、Windows 进程树或真实 Screeps 安装上验收。工具的退出码/`stop-result.ok` 只反映控制流程，不代表 `ENGINE_LAB_PASS`，也不证明已经发生 100H 转运。

所有实际环境操作须有执行会话中覆盖新实验的授权。这里没有安装、创建世界、装载代码或生产上传命令。不要连接既有世界、正式服、PTR、真实账号。

## 代码边界

- `controlProbe.ts` 是只读准备入口，读取现有控制槽和实际世界；根模块只导出 `loop`，不加载 send 入口，不写 Memory。`build-control-probe.cjs` 只构建固定四模块依赖图。
- `memory-control.cjs` 复用原 `controlRecord.ts` 的校验和 4096 字节语义。初始化、武装、撤装只走实际 env Memory。撤装保留 attempted/结果并设置既有 `stopped=true`，不能重新武装。
- `stop-controller.cjs` 消费真实 console 封装，按完整窗口或 180 秒先到请求暂停，并确认暂停；故障时走有界进程树终止。
- `local-runtime.cjs` 使用指定隔离安装的依赖，检查读取/写入 Memory 的源码路径与 hash；不把上游版本名当成本地安装证明。
- `process-scope.cjs` 只允许绑定一个 `node <隔离根目录内的绝对入口路径>` 进程，核对 PID、出生标记、可执行文件和命令行；不接受 shell/npm 包装或仅把隔离路径放在无关参数中的进程。实际 Windows/Linux 终止行为仍需 Agent 验证。
- `lab-control.cjs` 连接上述工具。管理侧读回与玩家脚本读回分别记载，前者明确为 `playerConfirmed=false`。

## 离线测试

在完整仓库运行 `npm ci` 后，从仓库根执行：

```bash
node --test test/lab/terminal-transfer/tools/calibration.spec.cjs \
  test/lab/terminal-transfer/tools/memory.spec.cjs \
  test/lab/terminal-transfer/tools/stop.spec.cjs
npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  test/lab/terminal-transfer/controlRemediation.test.ts
```

Jest wrapper 包含三个测试，调用上述真实 Node 测试套件；Node 的内部用例数与 Jest wrapper 用例数不能相加冒充全仓测试数。Node 使用项目实际安装的 TypeScript；交付者本地只用了全局 TypeScript 5.8.3，不能替代仓库锁定版本的验证。

## 命令入口

先执行 `node test/lab/terminal-transfer/tools/lab-control.cjs --help`。所有连接参数必须显式给出：

```text
--command <inspect|initialize|arm|disarm|observe-false|observe-armed|facts|run-formal>
--environment <新的隔离实验根目录，内部为 server/ 安装目录>
--host <127.0.0.1 或 ::1> --port <本实验 storage RPC 端口>
--pid <本实验 Node launcher PID>
--user <合成用户 ID> --username <lab- 或 lab_ 开头的合成用户名>
--experiment <labConfig.ts 中相同的实验 ID>
--out <此次命令专用的新证据目录，父目录已存在>
```

每个命令使用不同的 `--out`，拒绝覆盖旧输出。用户名和实验 ID 必须与编译配置相同；CLI 不是第二个运行时配置入口。证据目录应在隔离环境之外，避免环境清理时丢失日志。

额外参数：

| 命令 | 额外参数 |
|---|---|
| initialize、arm、observe-false、observe-armed | `--probe <只读准备产物 main.js>` |
| arm | `--proof <observe-false 的 console.jsonl>` |
| facts | `--proof <observe-armed 的 console.jsonl>`、`--last-world-change <最后一次 fixture/map 修改的真实 ISO 时间>` |
| run-formal | `--proof <observe-armed 的 console.jsonl>`、`--facts <facts 命令产出的 calibration-facts.json>`、`--observer <observer.js>`、`--single-shot <single-shot.js>`、`--main <正式 main.js>` |

正式三产物各自从独立构建目录读取同目录 manifest，要求源码 HEAD 和活动模块全部字节匹配。工具只回读和核对装载，不负责上传。

## 操作顺序（Agent 有授权后执行）

1. 创建新隔离环境、合成用户和两端合法 Terminal，完成地图/fixture 初始化，保存原始资料。源/目标仍为 W1N57→W10N57，H/100。实际身份、费用、结构 ID 重新读取；不能复用 cal-0002 的已结束世界。
2. 在 `labConfig.ts` 中绑定本轮身份和经实测的费用，准备阶段的 T 仅为未使用占位值，不构成正式发送窗口。源码提交后构建只读准备产物：
   `node test/lab/terminal-transfer/tools/build-control-probe.cjs --out <仓库外的新目录>`。
   活动代码只装载这个产物的 `main` 模块，不得残留其他经济入口。
3. 用户正常初始化后 env Memory 须已经是合法 JSON 对象。工具对缺失或损坏的整份 Memory 不会自动替换成 `{}`。若它还没有由真实 runner 初始化，先按已授权只读启动流程取得初始化事实；不要对错误路径写一个空对象蒙混过去。
4. 暂停并确认稳定，运行 `inspect`、`initialize`。后者仅为缺失控制槽创建 `armed=false, attempted=false`，不覆盖已有记录。
5. 运行 `observe-false`：工具先订阅并确认外部通道，再恢复一次；同一 bot 两个真实 tick 读到未武装记录后自动暂停。以其原始 `console.jsonl` 运行 `arm`，只做一次 false→true 写入。
6. 运行 `observe-armed`：同一只读入口、同一个控制记录，经两个真实 tick 读到 armed=true、attempted=false 后自动暂停。暂停后的 env 记录再次与玩家读数比较。任何失败不得重新武装、覆盖旧记录或清除 attempted。
7. 此时记录稳定 T0，运行 `facts` 保存原始两端观测与暂停事实。**现在才首次固定最终 T≥T0+3**；世界持续暂停。不要改身份、路线、费用或已武装记录。更新 `labConfig.ts` 的最终 T 和同步文档示例，提交、完成受影响验证、重建正式三产物，完整装载回读。
8. 使用实际 armed 原始日志和 facts 运行 `run-formal`。其再次验证实际 env 记录、活动模块、暂停点、C02 和暂停世界端点；订阅就绪后设置固定期限并仅恢复一次。
9. 正常收齐 T−2..T+20 后立即请求暂停；180 秒先到、采样异常或发送前拒绝则终止实验。保存终态，撤装并终止绑定进程树。Agent 独立解析 send 边界、实际返回、后续交易与库存变化，不能用工具 exit 0 当成转运成功。

准备阶段的两次恢复没有可达发送路径；正式阶段只有一次恢复和一个固定 T。代码装载及初始化仍由 Agent 在其环境执行并保存证据，本工具不暗中补做它们。

## 停止边界与失败处理

外部期限从恢复请求前使用单调时钟启动，不能在重连或重复样本后续期。完整窗口收到后，请求暂停的实际时刻计入此前日志落盘耗时；延迟超过 1 秒不计为正常及时停止。暂停返回值、暂停标记、稳定 tick 与进程树退出是不同事实。

本轮工具支持约 1 秒/tick 的隔离 fixture；连续 5 秒没有目标用户 console 封装会按通道故障停止，不能解释为“没有执行 send”。这是外部实验保护，不是任意 Screeps 世界的性能保证。若真实环境不满足此条件，应报告环境不适配，不在运行中扩大限制。

暂停或稳定确认 5 秒内失败，会尝试终止已绑定进程树；终止确认也有边界。若无法确认，结果必须保留 `PROCESS_STOP_UNCONFIRMED`，由 Agent 核对原 PID/启动身份及监听状态。绝不 `killall node`、全局 prune、删除未知目录或恢复该实验续跑。

发生失败时先保存输出，不静默修改代码后重新发一笔。当前 `calibrationCheck` 改动不能让旧失败实验升级为成功；库存不变或交易视图为空也不单独构成未执行证明。
