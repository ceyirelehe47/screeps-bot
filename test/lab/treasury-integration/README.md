# Treasury Terminal Integration I

状态：实现与局部测试交付；真实 facade/kernel 回归和真实引擎验收由完整仓库中的测试 Agent 执行。不是生产部署。`enabled.ts` 默认 `false`。

## 接入边界

这是一个新的、隔离的真实国库实验入口：使用生产 `createTreasuryService`、canonical contract、注册 adapter/reconciler 和 policy；不修改这些模块，不导入 `test/mock`，不接生产 main 或其他经济 writer。原裸 API 实验、Slice 0 测试与旧证据保持不变。

固定同用户 W1N57 → W10N57、H100，单在途，无 retry。仅支持无 Power effect、端点只含 H/energy 的合成场景，便于核对费用和容量。缺对象、读取失败、身份不一致不能算零库存。

`adapter.ts` 负责真实端点、唯一 `terminal.send` 调用与交易/世界匹配；`coordinator.ts` 将准备、授权、执行和受控结算接到实际 Treasury API。`assembly.ts` 只做装配。所有风险和活动业务仍由 `Memory.runtime.treasuryCore` 负责，没有另建库存账本或持久队列。

保留原 `__labTerminalTransferProbe` 作为本次实验的单次运行保护：发送前写 attempted 并读回、最多 4096 字节。它不替代国库授权，不存第二份国库义务。资源、费用和接收容量必须通过 Treasury 的实际查询口径核对。

## 费用和观察

本场景 C02 固定 `cap=q`。准备/执行时重新报价必须等于这一冻结值，否则零调用。授权派生 source H−100、source energy−q、target H+100 三腿；OK 当 tick 仍为 unknown。

之后，唯一相关交易必须完整匹配双方、路线、H100、完整 description、唯一 T，且两侧视图一致。两端库存和容量同时验证。仅在这个无其他 writer 的隔离场景中，将源 energy 净减少量作为观测费用；允许 `1 ≤ observedFee ≤ q`，但不改写冻结 q，不把低费用解释为已证实的费用模型。缺记录、部分量、多个相关 ID、同 ID 副本矛盾、超预算或缺端点均保持 unknown，不补发。

真实 processor 不会替玩家脚本调用测试宿主的世界序 hook。因此协调器仅在完整交易+实际端点+当前 Treasury observation 已匹配后，调用现有 `bumpTreasuryWorldSequence` 并重建观察；随后仍由注册 reconciler 经 `settleUnknownOutcome` 再判一次。不是每 tick 自动 bump，不在只读 reconciler 内写状态，不直接写 kernel 聚合或自报结算凭证。

## 构建和运行

```sh
node test/lab/treasury-integration/build.cjs --out /absolute/new/external/bundle-dir
```

输出一个 `main.js` 和 manifest。构建器读取真实生产依赖，拒绝 mock、测试文件、生产 main/runtimeServices、原始 singleShot、Node 运行时依赖和动态 require。唯一允许的外部依赖 lodash 对应游戏 `_`。源图必须已提交、与 HEAD 一致；输出必须是仓库外的新目录，不覆盖 dist。

准备期仍用原 `lab-control.cjs` 的 inspect/initialize/observe-false/arm/observe-armed/facts。先完整初始化地图和 fixture，再统一重启相关引擎进程、获得新基线。最终 T 在真实已武装往返后首次固定；同时启用 `enabled.ts`、提交、验证、重建。

正式运行仅装载新 bundle 的 **一个 main 模块**，不能附带裸 API single-shot。调用：

```sh
node test/lab/terminal-transfer/tools/lab-control.cjs \
  --command run-treasury \
  --environment /absolute/new-isolated-env --host ::1 --port 21027 \
  --pid BOUND_LAUNCHER_PID --user SYNTHETIC_USER_ID --username COMPILED_USERNAME \
  --experiment COMPILED_EXPERIMENT_ID --out /absolute/new/run-evidence \
  --proof /absolute/observe-armed/console.jsonl --facts /absolute/facts/calibration-facts.json \
  --main /absolute/new/external/bundle-dir/main.js
```

这些大写位置须填实际值，不能使用旧 ec0001 的配置。本包默认禁用，也不提供跳过确认的 CLI 参数。

run-treasury 检查当前源码、manifest 和实际活动模块字节，再沿原一次恢复、T−2..T+20、180 秒先到停止的流程。除原始 console、Memory/交易/对象快照外，保存 `process-stop-result.json` 和 `treasury-verification.json`。PASS 同时要求真实到账、国库 pending→unknown→committed→退出、查询不残留重复扣减、及时暂停与自动进程确认；不能仅凭 `OK`、测试通过或 active 为空下结论。

## 验证

```sh
node --test test/lab/treasury-integration/local.spec.cjs test/lab/treasury-integration/process.spec.cjs test/lab/treasury-integration/tooling.spec.cjs
npx jest --config jest.config.cjs --runInBand --runTestsByPath test/lab/treasury-integration/integration.test.ts test/lab/treasury-integration/tools.test.ts
node test/lab/treasury-integration/process-smoke.cjs --run-owned-process-smoke
```

最后一项只创建自己的临时 Node launcher+6 个空闲子进程并终止，不启动 Screeps、不监听端口。Linux 已在交付端执行；Windows 必须在 Agent 机器上执行。模拟 OS 查询测试不等于 Windows 实证。

Jest integration 用例连接实际 facade/kernel，仅 Game API/世界更新是假端口；世界修改特意不调用原 fake host 的 world-sequence bump。验证 lower fee、closing 期间不双扣、缺证据保持 unknown、不同 workKey 阻断、假许可、完整模块 reset 后恢复。离线与实机失败均保留原输入与日志，不反向发送、清 unknown、换 T 或重武装试到成功。
