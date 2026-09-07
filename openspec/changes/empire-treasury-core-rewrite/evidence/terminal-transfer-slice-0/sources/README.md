# sources/ — 固定来源源码副本（M02）

访问日期 2026-09-07；每份文件的 SHA-256 见 `sha256.txt`（与归档时计算一致）。

| 文件 | 来源与版本 |
| --- | --- |
| `src_game_structures.js` | screeps/engine `80977824199a596d174d392fd0cf8c458c21fcbd` `src/game/structures.js`（Terminal.send L714–745） |
| `src_processor_intents_terminal_send.js` | 同 SHA `src/processor/intents/terminal/send.js`（处理层重查） |
| `src_processor_global-intents_market.js` | 同 SHA `src/processor/global-intents/market.js`（executeTransfer L15–69；send 分支 L71–95） |
| `src_processor_global.js` | 同 SHA `src/processor/global.js`（global intents 执行入口） |
| `src_game_market.js` | 同 SHA `src/game/market.js`（交易视图 L203–233） |
| `src_utils.js` | 同 SHA `src/utils.js`（calcRoomsDistance L644–655、calcTerminalEnergyCost L657–659） |
| `engine_main.js` | 同 SHA `src/main.js`（主循环阶段——效果 T+1 可见的依据） |
| `engine_runner.js` | 同 SHA `src/runner.js`（saveResult 并行保存 L15–50） |
| `driver_lib_runtime_runtime.js` | screeps/driver master `cf63d8adf902663e2ebddd7f8c5b7baa425dc928` `lib/runtime/runtime.js`（用户代码结束→Memory 序列化→单一 outMessage） |
| `driver_lib_index.js` | 同 SHA `lib/index.js`（saveUserMemory L153–159，>2MB 拒绝） |

固定 SHA 仅为**可复核的开源源码基准**，不代表已确认正式服使用相同版本（任务书 §3.2）。结论汇编见 `openspec/…/terminal-transfer-slice-0.md` §1。
