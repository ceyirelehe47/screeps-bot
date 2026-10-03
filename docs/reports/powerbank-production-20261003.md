# PowerBank 正式发布记录

日期：2026-10-03（Asia/Shanghai）。用户明确授权“接下来推进上线”。目标：账号 forster、`screeps.com/default/shard1`。采用 CLI/API，未使用浏览器。

## 第一版发布与回退

冻结源码 `f74973a166caa6ac5bbae34aee9175ec1137a5cd`，版本 `2026.10.3-7`，main SHA `7f6d7a81ba86922429627324bd0ee7574328ff262ada4741ec9321806595ea22`、3461463字节。服务器完整225 suites/1383 tests、双类型检查和构建通过；工件保字节取回，没有重新构建或修改上传内容。

正式前置读取确认旧 main SHA `1bf02d8415f552239dd034865c4e62d5c6a00a978af36f78b64640ea05f6f061`、shard1 活跃、8个己方房间；完整四 shard Memory 均通过无未结 Treasury 责任门。发布使用干净 exact f749 检出和原 `deploy-frozen-t4.mjs`，没有放宽源码/账户/branch/工具哈希门；私有目录备份原代码与全部 Memory。

一次 code POST 获 accepted，独立 GET 回读与7f6d冻结字节完全一致；首个运行标记 tick74101236。实际 Observer 覆盖108个高速房，发现7个 PB，`target_combat_threat` 有实际命中。Treasury 配置保持空，未 arm 或开启 PvP，也未注入测试任务。

WebSocket 观察4分钟收到115条 console/CPU事件，错误事件0；完整生产 tick 持续推进。但后续原生 CPU 证明该版不宜保留：

| 时点 | tick | CPU | EMA | bucket | PB Harvest |
|---|---:|---:|---:|---:|---:|
| 原版前置 | 74101111 | 61.76 | 74.78 | 10000 | 0.17 |
| 新版观察 | 74101293 | 142.64 | — | 9044 | 80.27 |
| 新版继续观察 | 74101342 | 112.62 | 112.55 | 8573 | 42.60 |
| 新版约183 tick后 | 74101419 | 141.14 | 133.53 | 6772 | 68.20 |

CPU limit120、tickLimit500。7个任务仍处于 discovered 等待，未得到完整路径准入。这里将代码上传成功与原生运行退化分别记录，不把 mock/服务器 PASS 当作线上成本通过。

2026-10-03 21:59:21 执行一次 code-only restore POST，accepted，独立 GET 确认恢复原1bf字节。没有重试未知上传，没有改写/清空 Memory、旗帜或控制配置。之后只读原生诊断 tick74101782 的 bucket 恢复10000。

## 原生诊断与成本修正

未证实路径边界校验错误。首个相邻房诊断 maxOps1000 搜索未完成；第二个诊断错误假定 E1N57 有 LEFT 出口，出现只读 console 表达式异常，失败原件保留。改用实际有效出口后，maxOps300 的原生 PF 返回 incomplete=false、ops1：E1N57 `(4,0)` 到 E1N58 `(4,49)`，符合当前世界坐标相邻门。因此保留原路径连续性/障碍/同房 goal 校验。

确定的成本问题：测量计数门之前已经扫描状态/拓扑；Harvest 等待时反复评估后续所有来源；路径后处理每格重复读取状态和地形；Observer、Harvest 重复生成搜房集合。

修正版 `2026.10.3-8`、源码 `d28803312b9142cb049ec0790992c773d7d06359`：新输入提前预算等待，缓存命中仍核当前状态/几何；单测量复用状态/地形/道路/疲劳；同 tick、同 Game、同输入复用搜房集合并返回副本；Harvest 配额耗尽立即停后续来源/Spawn 评估。最终依旧要求当次完整、fresh 来源集合，不能用部分结果投入资源。

## 修正版验证与发布

修正版服务器 dual typecheck 均 exit0；33 suites/252 tests 定向全通过，覆盖15套 PB、13套 Movement 和 Memory/ABI/角色/任务架构边界。完整发现225套实际执行一次，225 suites/1393 tests 全通过，0 skip/todo/runtime errors，416秒。Jest JSON SHA `158dd1743393b1ff571b8c5df38adf07a47283d0e1fd9744b530bdcfbc65037d`。

修正版仅构建、OpenSpec status/apply instructions/strict 也均实际 exit0，源 d288、tree `44e53c91cb6f0079d7e7ebb075eb592b1299f6f4` 干净。验证 record SHA `dd440ddbaa7fd2e75069c9e761bb625ee6ee22c4d6205aaafa8f53464d2ca1de`。冻结 main SHA `3dd595018ed5e2ba04a4035f20e4afb6b47162b63585852cf21c2f3697230e96`、3463882字节。

修正版再次使用原发布入口、exact d288 干净检出；fresh 四 shard 前置门通过，一次 code POST accepted，独立回读与3dd冻结字节一致。正式运行标记为 `2026.10.3-8+d288033@2026-10-03T14:45:21.230Z`，生效 tick74102496。观察结束后再次 GET 确认正式 main 仍为3dd。

约6分钟 WebSocket/Memory观察收到181条 console/CPU事件，错误事件0。新版7个原生样本 tick74102504–74102567：总CPU约65.90–98.94，PB Harvest约6.97–10.05；limit120。首次冷启动后 bucket9825，下一样本即恢复10000并保持至窗口末尾。最后 EMA100.85，完整生产 tick推进至74102570，覆盖仍为108房。

当前保留 `2026.10.3-8` 正式运行。窗口中发现最多12个 PB，状态处于视野、威胁或测路等待；未观察到新任务带测距字段进入准备阶段，因此本记录不声称已验证原生开采/搬运收益闭环或长期测量收敛。已证明的是正式字节、运行身份、动态发现、威胁拦截和本次短窗口 CPU 稳定；首次退化版完整保留且已回退。

## 证据

私有原件根：`/Users/forst/Downloads/screeps-powerbank-deploy-20261003/`，代码/Memory/冻结工件不纳入 Git，认证文件和 token 不复制或打印。

- `frozen/`：初版运行模块、SHA manifest、281个源码文件清单；不上传源码映射模块。
- `release-manifest.json`、`check.log`、`apply.log`：原入口校验与一次 POST 回执。
- `upload-audit/`：原代码、四 shard Memory 私有备份。
- `post-readonly/`、`runtime-followup-r2.json`：独立代码回读、运行标记、CPU 与任务状态。
- `live-events.jsonl`、`live-watch-summary.json`：4分钟实时 console/CPU。只读 console 请求获排队确认但该结果未被窗口捕获，不作为执行证明。
- `rollback/`：单次恢复尝试、accepted 与1bf回读结果。
- `native-path-diagnostic/`、`native-exit-diagnostic/`、`native-valid-exit-diagnostic/`：限额只读诊断；失败与成功样本均保留。
- `candidate-r4-results/`、`frozen-r4/`：修正版全部服务器原件和冻结字节。
- `release-manifest-r4.json`、`check-r4.log`、`apply-r4.log`、`upload-audit-r4/`：修正版前置、一次POST、回读及备份。
- `live-r4/summary.json`、`live-r4/events.jsonl`、`final-code.json`：原生短窗口与最后独立代码回读。

整次发布共2次候选 code POST、1次 restore code POST；另有4次只读 console表达式提交，未写 Memory 或发布业务意图。没有重试未知上传，没有手动开启 Treasury 灰度或 PvP。正式游戏自身的自然业务行为与这些操作计数分开。
