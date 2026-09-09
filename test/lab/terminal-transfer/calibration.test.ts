/**
 * Terminal Transfer Engine Lab Run I · Calibration Rerun——独立配置核对
 * 自测（任务书 §5.3，场景 B–G；场景 A 的门禁复现在 probe.test.ts）。
 *
 * 验证对象是**实际比较实现** checkLabCalibration（test/lab/terminal-transfer/
 * calibrationCheck.ts）与 CLI scripts/verify-lab-calibration.mjs——不在测试里
 * 重写一份永远返回预期值的"验证器"。facts 来自独立落盘的 fixtures（不由待验
 * config 生成）；所有用例共享同一健康基线 fixture，变体只深拷贝改写或修改
 * 待验 config，基线文件本身不得随之变化（场景 B）。
 *
 * 场景对照（§5.3）：B 三项同时错误一次全部暴露；C 配置侧自洽但独立事实
 * 不一致仍拒绝；D 缺失/不可读/混用/陈旧不当作健康；E 非 26 报价证明无
 * 硬编码（cap 必须与报价相等绑定）；F 完整健康基线通过；G CLI 只读且
 * 真实命令可执行（正式验证与武装前记录另行归档——测试通过不等于 C02
 * 的"真实使用"已满足）。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LAB_EXAMPLE_EXPERIMENT, type LabExperimentConfig } from "./labConfig";
import { checkLabCalibration, type CalibrationCheckItem, type CalibrationReport } from "./calibrationCheck";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const CLI = join(REPO_ROOT, "scripts", "verify-lab-calibration.mjs");
const FACTS_HEALTHY = join(__dirname, "fixtures", "calibration-facts-healthy.json");
const FACTS_MISMATCH = join(__dirname, "fixtures", "calibration-facts-mismatch.json");

/**
 * 独立基线（磁盘 fixture）——唯一事实来源；变体一律在深拷贝上改写。
 * JSON 宽松类型（any）仅供测试构造输入；核对逻辑的类型约束在被测实现
 * calibrationCheck.ts 内部。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadHealthyFacts(withCodeSource: boolean): any {
  const facts = JSON.parse(readFileSync(FACTS_HEALTHY, "utf8"));
  if (withCodeSource) {
    facts.context.codeSource = { repoHead: "fixture-head", labConfigSha256: "fixture-config-sha" };
  }
  return facts;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cloneFacts(facts: any): any {
  return JSON.parse(JSON.stringify(facts));
}

function findItem(report: CalibrationReport, category: string, item: string): CalibrationCheckItem {
  const found = report.checks.find((entry) => entry.category === category && entry.item === item);
  if (found === undefined) throw new Error(`报告中缺少 ${category}/${item}`);
  return found;
}

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

describe("Terminal Transfer Lab Run I · Calibration Rerun——独立配置核对（C02）", () => {
  it("场景 F 正常对照：独立取得的完整健康基线 + 匹配配置 → 全部通过（无 fail/missing）", () => {
    const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, loadHealthyFacts(true));
    console.log(`CALIBRATION-F ${JSON.stringify(report.summary)}`);
    expect(report.status).toBe("pass");
    expect(report.summary.failed).toBe(0);
    expect(report.summary.missing).toBe(0);
    // 关键项抽查：绑定规则与时间窗。
    expect(findItem(report, "quote", "cap_binds_quote").result).toBe("pass");
    expect(findItem(report, "time_stability", "target_tick_reachable").result).toBe("pass");
    expect(findItem(report, "world_user", "shard_matches_config").observed).toBe("Forst");
  });

  it("场景 B 三项同时错误：shard/源结构 ID/费用上限一次性全部暴露；只修一项不减少其余两项；基线文件字节不随 config 变化", () => {
    const facts = loadHealthyFacts(true);
    const fixtureShaBefore = sha256Of(FACTS_HEALTHY);
    const wrong: LabExperimentConfig = {
      ...LAB_EXAMPLE_EXPERIMENT,
      shardName: "shard0",
      sourceTerminalId: "aaaaaaaaaaaaaaaa",
      maxFeeEnergy: 999,
    };
    const report = checkLabCalibration(wrong, facts);
    expect(report.status).toBe("fail");
    // 三项差异同时出现（不因第一项 shard 失败而省略源 ID 与费用检查）。
    expect(findItem(report, "world_user", "shard_matches_config").result).toBe("fail");
    expect(findItem(report, "endpoints", "source_terminal_id").result).toBe("fail");
    expect(findItem(report, "quote", "cap_binds_quote").result).toBe("fail");
    // 逐项修复：每修一项只消掉对应 fail，其余两项仍在。
    const fixShard = checkLabCalibration({ ...wrong, shardName: LAB_EXAMPLE_EXPERIMENT.shardName }, facts);
    expect(findItem(fixShard, "world_user", "shard_matches_config").result).toBe("pass");
    expect(findItem(fixShard, "endpoints", "source_terminal_id").result).toBe("fail");
    expect(findItem(fixShard, "quote", "cap_binds_quote").result).toBe("fail");
    const fixSource = checkLabCalibration({ ...wrong, sourceTerminalId: LAB_EXAMPLE_EXPERIMENT.sourceTerminalId }, facts);
    expect(findItem(fixSource, "world_user", "shard_matches_config").result).toBe("fail");
    expect(findItem(fixSource, "endpoints", "source_terminal_id").result).toBe("pass");
    expect(findItem(fixSource, "quote", "cap_binds_quote").result).toBe("fail");
    const fixCap = checkLabCalibration({ ...wrong, maxFeeEnergy: LAB_EXAMPLE_EXPERIMENT.maxFeeEnergy }, facts);
    expect(findItem(fixCap, "world_user", "shard_matches_config").result).toBe("fail");
    expect(findItem(fixCap, "endpoints", "source_terminal_id").result).toBe("fail");
    expect(findItem(fixCap, "quote", "cap_binds_quote").result).toBe("pass");
    // 基线不随待验 config 变化：fixture 文件字节前后一致。
    expect(sha256Of(FACTS_HEALTHY)).toBe(fixtureShaBefore);
  });

  it("场景 C 拒绝虚假自洽：配置侧自洽（labConfig 与文档 JSON 一致）但独立事实不一致 → 仍拒绝", () => {
    // 配置侧自洽证据（manifest 由构建时同一 labConfig 内嵌、runI.test 另行
    // 断言）：labConfig 常量与仓库文档 example.experiment.json 一致。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docJson = JSON.parse(readFileSync(join(__dirname, "example.experiment.json"), "utf8")) as any;
    expect(docJson).toMatchObject({ ...LAB_EXAMPLE_EXPERIMENT });
    const facts = cloneFacts(loadHealthyFacts(true));
    facts.samples = facts.samples.map((sample: any) => ({ ...sample, shard: { name: "shard0" } }));
    const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
    expect(report.status).toBe("fail");
    expect(findItem(report, "world_user", "shard_matches_config").result).toBe("fail");
    // 反向说明信任模型：把 config 改成迎合错误事实可以让该项通过——这正是
    // facts 必须独立取得（不由 config 生成）的原因；事实本身从未被 config
    // 改写。该分支只作信任模型文档，不构成"用配置修正事实"的支持。
    const configChasingFacts = checkLabCalibration({ ...LAB_EXAMPLE_EXPERIMENT, shardName: "shard0" }, facts);
    expect(findItem(configChasingFacts, "world_user", "shard_matches_config").result).toBe("pass");
    expect(configChasingFacts.status).toBe("pass");
  });

  it("场景 D 缺失与混用：缺 shard/缺身份/单 tick/读取错误/缺健康字段/混用/陈旧均不通过；首项失败不影响其余项继续报告", () => {
    const base = () => cloneFacts(loadHealthyFacts(true));
    // (a) shard 读取错误：shard_legal 失败，但源 ID 与费用检查仍被报告（一次报全部）。
    {
      const facts = base();
      facts.samples = facts.samples.map((sample: any) => ({ ...sample, shard: { readError: "采样器读取异常" } }));
      const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
      expect(report.status).toBe("fail");
      expect(findItem(report, "world_user", "shard_legal").result).toBe("fail");
      expect(findItem(report, "endpoints", "source_terminal_id").result).toBe("pass");
      expect(findItem(report, "quote", "cap_binds_quote").result).toBe("pass");
    }
    // (b) 缺 shard 名（undefined）。
    {
      const facts = base();
      facts.samples = facts.samples.map((sample: any) => ({ ...sample, shard: {} }));
      expect(findItem(checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts), "world_user", "shard_legal").result).toBe("fail");
    }
    // (c) 缺 Terminal 身份（readStatus terminal_missing——与 worldRead 行为一致，
    // 缺结构时数值/健康字段一律不出现，不由残留旧值冒充）。
    {
      const facts = base();
      facts.samples = facts.samples.map((sample: any) => ({ ...sample, source: { readStatus: "terminal_missing" } }));
      const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
      expect(findItem(report, "endpoints", "source_read_ok").result).toBe("fail");
      expect(findItem(report, "endpoints", "source_terminal_id").result).toBe("fail");
      expect(findItem(report, "resources", "source_h_sufficient").result).toBe("fail"); // 不可读不转换为健康
    }
    // (d) 只有一个 tick。
    {
      const facts = base();
      facts.samples = [facts.samples[0]];
      expect(findItem(checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts), "time_stability", "samples_two_ticks").result).toBe("fail");
    }
    // (e) 端点读取错误 + my 缺失（必要健康字段）。
    {
      const facts = base();
      facts.samples = facts.samples.map((sample: any) => ({ ...sample, target: { ...sample.target, readStatus: "read_error", my: undefined } }));
      const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
      expect(findItem(report, "endpoints", "target_read_ok").result).toBe("fail");
      expect(findItem(report, "endpoints", "target_my_active").result).toBe("fail");
    }
    // (f) 不同运行的资料混用（第二样本 runId 不同）。
    {
      const facts = base();
      facts.samples = facts.samples.map((sample: any, index: number) => ({ ...sample, runId: index === 0 ? facts.context.runId : "another-run" }));
      expect(findItem(checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts), "provenance", "run_id_consistent").result).toBe("fail");
    }
    // (g) 陈旧：样本早于最后管理修改时刻（管理改过 fixture 后未重新取得新鲜事实）。
    {
      const facts = base();
      facts.samples = facts.samples.map((sample: any) => ({ ...sample, collectedAtWallClock: "2026-09-09T10:03:00.000Z" }));
      expect(findItem(checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts), "time_stability", "collected_after_admin_change").result).toBe("fail");
    }
    // (h) 缺失记 missing，不当作健康：未声明管理修改时刻/用户 ID/交易视图/代码来源。
    {
      const facts = base();
      delete facts.context.lastAdminChangeWallClock;
      delete facts.context.user;
      facts.samples = facts.samples.map((sample: any) => ({ ...sample, transactions: {} }));
      delete facts.context.codeSource;
      const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
      expect(report.status).toBe("fail");
      expect(findItem(report, "time_stability", "collected_after_admin_change").result).toBe("missing");
      expect(findItem(report, "world_user", "user_id_evidence").result).toBe("missing");
      expect(findItem(report, "experiment_scope", "description_unique").result).toBe("missing");
      expect(findItem(report, "provenance", "code_source").result).toBe("missing");
    }
    // (i) 报价不可用。
    {
      const facts = base();
      facts.samples = facts.samples.map((sample: any) => ({ ...sample, feeQuote: { status: "unavailable", error: "报价端口异常" } }));
      const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
      expect(findItem(report, "quote", "quote_legal").result).toBe("fail");
      expect(findItem(report, "quote", "cap_binds_quote").result).toBe("fail");
    }
    // (j) 空样本集不崩溃且整体 fail。
    {
      const facts = base();
      facts.samples = [];
      const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
      expect(report.status).toBe("fail");
      expect(report.summary.total).toBeGreaterThan(0);
    }
  });

  it("场景 E 报价无硬编码（非 26 报价）：cap=30 与报价 30 绑定通过；29/31 均判绑定不符；非整数/负数报价拒绝", () => {
    const facts = cloneFacts(loadHealthyFacts(true));
    facts.samples = facts.samples.map((sample: any) => ({ ...sample, feeQuote: { status: "ok", energyCost: 30 } }));
    const bound = checkLabCalibration({ ...LAB_EXAMPLE_EXPERIMENT, maxFeeEnergy: 30 }, facts);
    expect(findItem(bound, "quote", "quote_legal").result).toBe("pass");
    expect(findItem(bound, "quote", "quote_stable").result).toBe("pass");
    expect(findItem(bound, "quote", "cap_binds_quote").result).toBe("pass");
    expect(findItem(checkLabCalibration({ ...LAB_EXAMPLE_EXPERIMENT, maxFeeEnergy: 29 }, facts), "quote", "cap_binds_quote").result).toBe("fail");
    expect(findItem(checkLabCalibration({ ...LAB_EXAMPLE_EXPERIMENT, maxFeeEnergy: 31 }, facts), "quote", "cap_binds_quote").result).toBe("fail");
    // 非法报价值：非整数与负数都不是"新鲜合法报价"。
    for (const energyCost of [30.5, -1]) {
      const bad = cloneFacts(facts);
      bad.samples = bad.samples.map((sample: any) => ({ ...sample, feeQuote: { status: "ok", energyCost } }));
      expect(findItem(checkLabCalibration({ ...LAB_EXAMPLE_EXPERIMENT, maxFeeEnergy: 30 }, bad), "quote", "quote_legal").result).toBe("fail");
    }
  });

  it("场景 G CLI 只读与真实命令：健康 fixture 退出 0、三项不一致 fixture 退出 1 且三项齐报、坏输入退出 2；运行前后输入文件字节不变", () => {
    const watched = [FACTS_HEALTHY, FACTS_MISMATCH, join(__dirname, "labConfig.ts"), join(__dirname, "example.experiment.json")];
    const before = watched.map(sha256Of);
    // 健康：exit 0，报告 pass，config 来源指向实际 labConfig.ts 字节。
    const healthy = spawnSync(process.execPath, [CLI, "--facts", FACTS_HEALTHY], { encoding: "utf8" });
    expect(healthy.status).toBe(0);
    const healthyOutput = JSON.parse(healthy.stdout as string);
    expect(healthyOutput.report.status).toBe("pass");
    expect(healthyOutput.inputs.configSource.sha256).toBe(sha256Of(join(__dirname, "labConfig.ts")));
    expect(healthyOutput.config.experimentId).toBe(LAB_EXAMPLE_EXPERIMENT.experimentId);
    // 三项不一致：exit 1，三项差异同时出现在同一份报告。
    const mismatch = spawnSync(process.execPath, [CLI, "--facts", FACTS_MISMATCH], { encoding: "utf8" });
    expect(mismatch.status).toBe(1);
    const mismatchOutput = JSON.parse(mismatch.stdout as string);
    expect(mismatchOutput.report.status).toBe("fail");
    const failedItems = mismatchOutput.report.checks
      .filter((entry: CalibrationCheckItem) => entry.result === "fail")
      .map((entry: CalibrationCheckItem) => `${entry.category}/${entry.item}`);
    for (const expected of ["world_user/shard_matches_config", "endpoints/source_terminal_id", "quote/cap_binds_quote"]) {
      expect(failedItems).toContain(expected);
    }
    // 坏输入：exit 2。
    const missing = spawnSync(process.execPath, [CLI, "--facts", join(__dirname, "fixtures", "does-not-exist.json")], { encoding: "utf8" });
    expect(missing.status).toBe(2);
    // 只读：运行前后所有被读文件字节不变。
    expect(watched.map(sha256Of)).toEqual(before);
  });
});

// 场景 A（旧事故链门禁复现）与 C01 严格 shard 拒绝矩阵在 probe.test.ts
// （门禁函数与真实产物层面）。

/**
 * Control Remediation I —— Agent 独立增补反例（R02）。
 *
 * 与包内 tools/calibration.spec.cjs（P01–P12）互补：这里聚焦配置侧非法
 * T、报价字段整体缺失、暂停点类型非法、"稳定但不满足发送条件"的数值
 * （cooldown≠0 / energy<cap / 目标空位不足 / controller level<6），以及
 * 三样本反序时中间样本缺字段不被排序掩盖。全部用例在深拷贝上改写。
 */
describe("Control Remediation I —— Agent 独立增补反例（R02）", () => {
  it("配置侧 targetTick 非法（小数/负数/字符串/null）→ target_tick_reachable fail 且不崩溃", () => {
    for (const targetTick of [200.5, -1, "201", null]) {
      const report = checkLabCalibration(
        { ...LAB_EXAMPLE_EXPERIMENT, targetTick: targetTick as unknown as number },
        cloneFacts(loadHealthyFacts(true)),
      );
      expect(report.status).toBe("fail");
      expect(findItem(report, "time_stability", "target_tick_reachable").result).toBe("fail");
    }
  });

  it("早期样本 feeQuote 整字段缺失或为 null → quote 三项（legal/stable/cap 绑定）全部 fail，不因最新样本正常而放行", () => {
    for (const mutate of [
      (sample: any) => { delete sample.feeQuote; },
      (sample: any) => { sample.feeQuote = null; },
    ]) {
      const facts = cloneFacts(loadHealthyFacts(true));
      mutate(facts.samples[0]);
      const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
      expect(findItem(report, "quote", "quote_legal").result).toBe("fail");
      expect(findItem(report, "quote", "quote_stable").result).toBe("fail");
      expect(findItem(report, "quote", "cap_binds_quote").result).toBe("fail");
    }
  });

  it("pauseConfirmedTick 类型非法（字符串/null/负数）→ paused_confirmed 与 target_tick_reachable 均 fail", () => {
    for (const pauseConfirmedTick of ["198", null, -1]) {
      const facts = cloneFacts(loadHealthyFacts(true));
      facts.context.pauseConfirmedTick = pauseConfirmedTick;
      const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
      expect(findItem(report, "time_stability", "paused_confirmed").result).toBe("fail");
      expect(findItem(report, "time_stability", "target_tick_reachable").result).toBe("fail");
    }
  });

  it("两端数值『稳定但发送条件不满足』：源 cooldown=10 / 源 energy=20<cap / 目标空位=50<100 → 对应发送条件 fail（稳定性检查本身合法）", () => {
    const cases: Array<{ mutate: (facts: any) => void; category: string; item: string; stabilityItem: string; side: string; field: string }> = [
      {
        mutate: (facts) => { for (const s of facts.samples) s.source.cooldown = 10; },
        category: "resources", item: "source_cooldown_zero", stabilityItem: "source_cooldown_stable", side: "source", field: "cooldown",
      },
      {
        mutate: (facts) => { for (const s of facts.samples) s.source.energy = 20; },
        category: "resources", item: "source_energy_covers_cap", stabilityItem: "source_energy_stable", side: "source", field: "energy",
      },
      {
        mutate: (facts) => { for (const s of facts.samples) s.target.freeCapacity = 50; },
        category: "resources", item: "target_free_sufficient", stabilityItem: "target_freeCapacity_stable", side: "target", field: "freeCapacity",
      },
    ];
    for (const { mutate, category, item, stabilityItem } of cases) {
      const facts = cloneFacts(loadHealthyFacts(true));
      mutate(facts);
      const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
      expect(findItem(report, category, item).result).toBe("fail");
      // 稳定且完整本身成立：非法的是数值语义，不是基线形状。
      expect(findItem(report, "resources", stabilityItem).result).toBe("pass");
    }
  });

  it("controller level 稳定为 5（<6）→ 两端 controller fail（controller_stable 本身 pass）", () => {
    const facts = cloneFacts(loadHealthyFacts(true));
    for (const sample of facts.samples) {
      sample.source.controller.level = 5;
      sample.target.controller.level = 5;
    }
    const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, facts);
    expect(findItem(report, "endpoints", "source_controller").result).toBe("fail");
    expect(findItem(report, "endpoints", "target_controller").result).toBe("fail");
    expect(findItem(report, "endpoints", "source_controller_stable").result).toBe("pass");
    expect(findItem(report, "endpoints", "target_controller_stable").result).toBe("pass");
  });

  it("三样本基线：反序后中间样本 target.cooldown 缺失仍被完整暴露；健康三样本反序 pass 且输入字节不变", () => {
    const threeSample = () => {
      const facts = cloneFacts(loadHealthyFacts(true));
      const extra = cloneFacts(facts.samples[1]);
      extra.tick = facts.samples[1].tick + 1;
      facts.samples.push(extra);
      return facts;
    };
    // 健康三样本（196/197/198，T0=198 仍 ≥ maxTick）：正序与反序均 pass。
    const healthyForward = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, threeSample());
    expect(healthyForward.status).toBe("pass");
    const reversed = threeSample();
    reversed.samples.reverse();
    const before = JSON.stringify(reversed);
    const healthyReversed = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, reversed);
    expect(healthyReversed.status).toBe("pass");
    expect(JSON.stringify(reversed)).toBe(before);
    // 反序 + 中间（按 tick 197）样本 target.cooldown 缺失：完整性与充分性同时暴露，
    // 不因数组首位（tick 198）健康而掩盖。
    const withGap = threeSample();
    withGap.samples.reverse();
    const mid = withGap.samples.find((sample: any) => sample.tick === 197);
    delete mid.target.cooldown;
    const report = checkLabCalibration(LAB_EXAMPLE_EXPERIMENT, withGap);
    expect(report.status).toBe("fail");
    expect(findItem(report, "resources", "target_cooldown_complete").result).toBe("fail");
    expect(findItem(report, "resources", "target_cooldown_stable").result).toBe("fail");
  });

  it("窗口可达性边界：T=T0+2 fail、T=T0+3 pass（healthy 即此值），不再以 maxSampleTick+3 冒充", () => {
    const facts = cloneFacts(loadHealthyFacts(true));
    // maxTick=197、T0=198：旧式 T≥maxTick+3 在 T=200 也会通过（197+3=200），
    // 但 T0+3=201 才保证 T−2=198 晚于暂停点。
    const t200 = checkLabCalibration({ ...LAB_EXAMPLE_EXPERIMENT, targetTick: 200 }, facts);
    expect(findItem(t200, "time_stability", "target_tick_reachable").result).toBe("fail");
    const t201 = checkLabCalibration({ ...LAB_EXAMPLE_EXPERIMENT, targetTick: 201 }, facts);
    expect(findItem(t201, "time_stability", "target_tick_reachable").result).toBe("pass");
    // T0 与最后样本同 tick（197）时的边界：T=T0+3=200 合法（窗口首样本
    // T−2=198 晚于暂停点），T=199（<T0+3）仍 fail。
    const latePause = cloneFacts(loadHealthyFacts(true));
    latePause.context.pauseConfirmedTick = 197;
    const t200b = checkLabCalibration({ ...LAB_EXAMPLE_EXPERIMENT, targetTick: 200 }, latePause);
    expect(findItem(t200b, "time_stability", "target_tick_reachable").result).toBe("pass");
    const t199b = checkLabCalibration({ ...LAB_EXAMPLE_EXPERIMENT, targetTick: 199 }, latePause);
    expect(findItem(t199b, "time_stability", "target_tick_reachable").result).toBe("fail");
  });
});
