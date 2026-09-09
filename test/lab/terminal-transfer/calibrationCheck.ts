/**
 * Terminal Transfer Engine Lab Run I · Calibration Rerun——独立配置核对
 * （任务书 §5，C02）。
 *
 * 纯比较模块：把固定源码实际使用的编译配置（labConfig.ts 导出的
 * LabExperimentConfig，由 CLI 转译加载）与独立落盘的真实玩家视图及
 * 暂停事实（CalibrationFacts，由只读元信息采样与收集通道组装，**不由
 * 待验 config 生成**）逐项比较，**一次报告全部可检测的不一致**——
 * 不因第一项 shard 失败而省略源 ID 与费用检查。
 *
 * 边界（任务书 §5.1）：
 * - 零游戏权限、零 I/O：不写文件、不连游戏、不写游戏 Memory、不武装
 *   控制槽、不调用 send；比较结果也不构成游戏运行时的新授权字段。
 * - 除 labConfig 的类型外不导入任何值（CLI 可对本文件单独转译求值）。
 * - 缺失事实记 result="missing"（无法核对），不当作健康、不填默认值；
 *   存在任一 fail/missing 即整体 status="fail"。
 * - 正式 gate（sendGate）保持遇错立即拒绝；本预检独立于运行时协议，
 *   二者不共享代码路径，也不互相放宽。
 *
 * worldSize 等诊断字段可随 facts 携带，但不参与核对（§5.2：world size
 * 是诊断事实，不是绕过报价比较的理由）。
 */

import type { LabExperimentConfig } from "./labConfig";

// ── facts 形状（内部数据布局；装配来源：只读元信息采样 + 收集器） ─────────

export interface CalibrationEndpointFacts {
  readonly readStatus: "ok" | "room_missing" | "terminal_missing" | "read_error";
  readonly terminalId?: string;
  readonly ownerUsername?: string;
  readonly my?: boolean;
  readonly isActive?: boolean;
  readonly controller?: { readonly present: boolean; readonly my?: boolean; readonly level?: number };
  readonly resourceAmount?: number;
  readonly energy?: number;
  readonly freeCapacity?: number | null;
  readonly cooldown?: number;
  readonly error?: string;
}

export interface CalibrationSampleFacts {
  readonly tick: number;
  readonly collectedAtWallClock?: string;
  readonly runId?: string;
  readonly shard?: { readonly name?: unknown; readonly readError?: string };
  readonly user?: { readonly username?: unknown };
  readonly source: CalibrationEndpointFacts;
  readonly target: CalibrationEndpointFacts;
  readonly feeQuote?: { readonly status?: string; readonly energyCost?: unknown; readonly error?: string };
  readonly transactions?: {
    readonly incoming?: { readonly status?: string; readonly records?: readonly Record<string, unknown>[] };
    readonly outgoing?: { readonly status?: string; readonly records?: readonly Record<string, unknown>[] };
  };
  /** 诊断字段（不参与核对）。 */
  readonly worldSize?: unknown;
}

export interface CalibrationFacts {
  readonly factsKind?: string;
  readonly context: {
    readonly collectedAtWallClock?: string;
    readonly runId?: string;
    readonly paused?: boolean;
    readonly pauseConfirmedTick?: number;
    readonly lastAdminChangeWallClock?: string;
    readonly user?: { readonly id?: unknown; readonly idSource?: unknown };
    readonly sampler?: { readonly name?: unknown; readonly version?: unknown };
    readonly codeSource?: { readonly repoHead?: unknown; readonly labConfigSha256?: unknown };
  };
  readonly samples: readonly CalibrationSampleFacts[];
}

// ── 报告形状 ────────────────────────────────────────────────────────────────

export type CalibrationCheckCategory =
  | "experiment_scope"
  | "world_user"
  | "endpoints"
  | "resources"
  | "quote"
  | "time_stability"
  | "provenance";

export interface CalibrationCheckItem {
  readonly category: CalibrationCheckCategory;
  readonly item: string;
  readonly result: "pass" | "fail" | "missing";
  readonly expected?: unknown;
  readonly observed?: unknown;
  readonly note?: string;
}

export interface CalibrationReport {
  readonly status: "pass" | "fail";
  readonly summary: { readonly total: number; readonly passed: number; readonly failed: number; readonly missing: number };
  readonly checks: readonly CalibrationCheckItem[];
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 逐项收集器：任何一项的登记都独立于其他项（无短路）。 */
class CheckCollector {
  readonly items: CalibrationCheckItem[] = [];
  add(category: CalibrationCheckCategory, item: string, result: CalibrationCheckItem["result"], fields?: { expected?: unknown; observed?: unknown; note?: string }): void {
    this.items.push({ category, item, result, ...fields });
  }
  boolean(category: CalibrationCheckCategory, item: string, ok: boolean, fields?: { expected?: unknown; observed?: unknown; note?: string }): void {
    this.add(category, item, ok ? "pass" : "fail", fields);
  }
  finish(): CalibrationReport {
    const passed = this.items.filter((entry) => entry.result === "pass").length;
    const failed = this.items.filter((entry) => entry.result === "fail").length;
    const missing = this.items.filter((entry) => entry.result === "missing").length;
    return {
      status: failed + missing > 0 ? "fail" : "pass",
      summary: { total: this.items.length, passed, failed, missing },
      checks: this.items,
    };
  }
}

/** 各样本同一标量读数的取值集合（附带出现过的 tick，供差异定位）。 */
function distinctObserved(samples: readonly CalibrationSampleFacts[], pick: (sample: CalibrationSampleFacts) => unknown): { values: unknown[]; ticks: Record<string, number[]> } {
  const values: unknown[] = [];
  const ticks: Record<string, number[]> = {};
  for (const sample of samples) {
    const value = pick(sample);
    const key = String(value);
    if (!values.some((existing) => String(existing) === key)) values.push(value);
    (ticks[key] ??= []).push(sample.tick);
  }
  return { values, ticks };
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/** 任务书 §0.2 固定的实验业务范围（预检同样按此固定路线核对，不接受自选路线）。 */
const FIXED_ROUTE = { sourceRoomName: "W1N57", targetRoomName: "W10N57" } as const;
/** send description 的实际 API 长度上限（按安装版本常量记录：100 字符）。 */
const DESCRIPTION_MAX_CHARS = 100;

export function checkLabCalibration(config: LabExperimentConfig, facts: CalibrationFacts): CalibrationReport {
  const checks = new CheckCollector();
  const samples = Array.isArray(facts.samples) ? facts.samples : [];
  const ticks = samples.map((sample) => sample.tick);
  const maxTick = ticks.length > 0 ? Math.max(...ticks) : undefined;

  // ── experiment_scope：实验范围（任务书固定值 + 描述可发送性 + 无同描述既有交易） ──
  checks.boolean("experiment_scope", "experiment_id", isNonEmptyString(config.experimentId) && /^[A-Za-z0-9._-]+$/.test(config.experimentId), {
    expected: "非空 ASCII 标识（字母/数字/点/下划线/连字符）",
    observed: config.experimentId,
  });
  checks.boolean("experiment_scope", "route", config.sourceRoomName === FIXED_ROUTE.sourceRoomName && config.targetRoomName === FIXED_ROUTE.targetRoomName, {
    expected: `${FIXED_ROUTE.sourceRoomName} -> ${FIXED_ROUTE.targetRoomName}`,
    observed: `${config.sourceRoomName} -> ${config.targetRoomName}`,
  });
  checks.boolean("experiment_scope", "resource_amount", config.resourceType === "H" && config.amount === 100, {
    expected: "H / 100",
    observed: `${config.resourceType} / ${config.amount}`,
  });
  checks.boolean("experiment_scope", "max_samples", config.maxSamples === 32, { expected: 32, observed: config.maxSamples });
  checks.boolean(
    "experiment_scope",
    "description",
    isNonEmptyString(config.description) && config.description.length <= DESCRIPTION_MAX_CHARS && /^[\x20-\x7E]+$/.test(config.description),
    { expected: `非空可打印 ASCII 且 ≤${DESCRIPTION_MAX_CHARS} 字符`, observed: config.description },
  );
  {
    // 无已有同描述记录：两视图任何样本出现 description 完全相等的既有交易即 fail；
    // 视图不可读（status 缺失/非 ok）记 missing——不能用"没读到"冒充"没有"。
    let conflicting: number | undefined;
    let unreadable = false;
    let checkedViews = 0;
    for (const sample of samples) {
      for (const direction of ["incoming", "outgoing"] as const) {
        const view = sample.transactions?.[direction];
        if (view === undefined) continue;
        if (view.status !== "ok" || !Array.isArray(view.records)) {
          unreadable = true;
          continue;
        }
        checkedViews += 1;
        for (const record of view.records) {
          if (record.description === config.description && conflicting === undefined) conflicting = sample.tick;
        }
      }
    }
    if (conflicting !== undefined) {
      checks.add("experiment_scope", "description_unique", "fail", { observed: `tick ${conflicting} 的交易视图含同 description 记录` });
    } else if (unreadable || checkedViews === 0) {
      checks.add("experiment_scope", "description_unique", "missing", { note: "交易视图缺失或不可读，无法核对既有同描述交易" });
    } else {
      checks.boolean("experiment_scope", "description_unique", true, { observed: `${checkedViews} 个可读视图无同 description 记录` });
    }
  }

  // ── world_user：shard/用户身份（缺失/不可读不转换为健康） ──────────────────
  {
    const shardEntries = samples.map((sample) => sample.shard);
    const latestEntry = shardEntries.length > 0 ? shardEntries[shardEntries.length - 1] : undefined;
    // 合法性按结构判定（readError/缺 name 均非法），展示值用带标记的字符串。
    const legalEvery =
      samples.length > 0 &&
      shardEntries.every((shard) => shard !== undefined && shard.readError === undefined && isNonEmptyString(shard.name));
    const displayNames = shardEntries.map((shard) =>
      shard === undefined ? "<missing>" : shard.readError !== undefined ? `<readError>${shard.readError}` : String(shard.name),
    );
    checks.boolean("world_user", "shard_legal", legalEvery, {
      expected: "每样本实际读到合法非空 shard 名",
      observed: samples.length === 0 ? "无样本" : JSON.stringify(displayNames),
      note: legalEvery ? undefined : "shard 缺失/读取错误/名字非法——不填约定值",
    });
    const latestName = latestEntry === undefined || latestEntry.readError !== undefined ? undefined : latestEntry.name;
    checks.boolean("world_user", "shard_matches_config", legalEvery && latestName === config.shardName, {
      expected: config.shardName,
      observed: latestName === undefined ? "<missing>" : latestName,
    });
    const stable = legalEvery && shardEntries.every((shard) => shard !== undefined && shard.name === latestName);
    checks.boolean("world_user", "shard_stable", stable, { expected: "各样本一致", observed: JSON.stringify(displayNames) });
  }
  {
    const usernames = samples.map((sample) => sample.user?.username);
    const usernamesOk = samples.length > 0 && usernames.every((name) => isNonEmptyString(name) && name === config.username);
    checks.boolean("world_user", "username_matches", usernamesOk, {
      expected: config.username,
      observed: samples.length === 0 ? "无样本" : JSON.stringify(usernames),
    });
    const userId = facts.context.user?.id;
    const idSource = facts.context.user?.idSource;
    if (isNonEmptyString(String(userId ?? "")) && isNonEmptyString(String(idSource ?? ""))) {
      checks.boolean("world_user", "user_id_evidence", true, { observed: `${String(userId)}（来源：${String(idSource)}）` });
    } else {
      checks.add("world_user", "user_id_evidence", "missing", { note: "合成用户 ID 或其证据来源缺失，无法核对用户身份" });
    }
  }
  {
    let ownerMismatches: string[] = [];
    for (const sample of samples) {
      for (const side of ["source", "target"] as const) {
        const owner = sample[side].ownerUsername;
        if (!isNonEmptyString(owner) || owner !== config.username) {
          ownerMismatches.push(`tick ${sample.tick} ${side}=${String(owner)}`);
        }
      }
    }
    checks.boolean("world_user", "endpoint_owners", samples.length > 0 && ownerMismatches.length === 0, {
      expected: `两端 owner 均为 ${config.username}`,
      observed: ownerMismatches.length === 0 ? `全部 ${samples.length} 样本一致` : ownerMismatches.join("; "),
    });
  }

  // ── endpoints：两端结构存在/ID 匹配且稳定/my+isActive/控制器合法 ────────────
  for (const side of ["source", "target"] as const) {
    const expectedId = side === "source" ? config.sourceTerminalId : config.targetTerminalId;
    const idObservation = distinctObserved(samples, (sample) => sample[side].terminalId);
    const readOk = samples.length > 0 && samples.every((sample) => sample[side].readStatus === "ok");
    checks.boolean("endpoints", `${side}_read_ok`, readOk, {
      expected: "readStatus=ok",
      observed: samples.length === 0 ? "无样本" : JSON.stringify(samples.map((sample) => sample[side].readStatus)),
    });
    checks.boolean("endpoints", `${side}_terminal_id`, readOk && idObservation.values.length === 1 && idObservation.values[0] === expectedId, {
      expected: expectedId,
      observed: JSON.stringify(idObservation.values),
      note: idObservation.values.length > 1 ? `各 tick 取值：${JSON.stringify(idObservation.ticks)}` : undefined,
    });
    const myActive = samples.length > 0 && samples.every((sample) => sample[side].my === true && sample[side].isActive === true);
    checks.boolean("endpoints", `${side}_my_active`, myActive, {
      expected: "my=true 且 isActive=true（每样本）",
      observed: samples.length === 0 ? "无样本" : `my=${JSON.stringify(samples.map((s) => s[side].my))} isActive=${JSON.stringify(samples.map((s) => s[side].isActive))}`,
    });
    const controllers = samples.map((sample) => sample[side].controller);
    const controllerOk = samples.length > 0 && controllers.every((c) => c !== undefined && c.present === true && c.my === true && finiteNumber(c.level) && c.level >= 6);
    checks.boolean("endpoints", `${side}_controller`, controllerOk, {
      expected: "控制器存在、同主且 level≥6（Terminal 合法）",
      observed: JSON.stringify(controllers),
    });
  }

  // ── resources：库存/能源/冷却/空位（缺失/不可读按 fail，不转换为 0 或健康） ──
  {
    const latest = samples.length > 0 ? samples[samples.length - 1] : undefined;
    const h = latest?.source.resourceAmount;
    checks.boolean("resources", "source_h_sufficient", finiteNumber(h) && h >= config.amount, {
      expected: `源 H ≥ ${config.amount}`,
      observed: h === undefined ? "不可读/缺失" : h,
    });
    const energy = latest?.source.energy;
    checks.boolean("resources", "source_energy_covers_cap", finiteNumber(energy) && energy >= config.maxFeeEnergy, {
      expected: `源 energy ≥ 固定上限 ${config.maxFeeEnergy}`,
      observed: energy === undefined ? "不可读/缺失" : energy,
    });
    const cooldown = latest?.source.cooldown;
    checks.boolean("resources", "source_cooldown_zero", finiteNumber(cooldown) && cooldown === 0, {
      expected: 0,
      observed: cooldown === undefined ? "不可读/缺失" : cooldown,
    });
    const free = latest?.target.freeCapacity;
    checks.boolean("resources", "target_free_sufficient", finiteNumber(free) && free >= config.amount, {
      expected: `目标空位 ≥ ${config.amount}`,
      observed: free === undefined || free === null ? "不可读/缺失" : free,
    });
  }

  // ── quote：新鲜合法报价 + 绑定规则 cap=q（发送时仍由 gate 执行实时 ≤ cap） ──
  {
    const latestQuote = samples.length > 0 ? samples[samples.length - 1].feeQuote : undefined;
    const cost = latestQuote?.energyCost;
    const quoteLegal =
      latestQuote !== undefined && latestQuote.status === "ok" && finiteNumber(cost) && (cost as number) >= 0 && Number.isInteger(cost);
    checks.boolean("quote", "quote_legal", quoteLegal, {
      expected: "最新样本报价 ok 且为非负有限整数（真实 calcTransactionCost 读数）",
      observed: latestQuote === undefined ? "无报价样本" : JSON.stringify(latestQuote),
    });
    const quoteObservation = distinctObserved(samples, (sample) => sample.feeQuote?.energyCost);
    checks.boolean("quote", "quote_stable", quoteLegal && quoteObservation.values.length === 1, {
      expected: "各样本报价一致",
      observed: JSON.stringify(quoteObservation.values),
      note: quoteObservation.values.length > 1 ? `各 tick 取值：${JSON.stringify(quoteObservation.ticks)}` : undefined,
    });
    checks.boolean("quote", "cap_binds_quote", quoteLegal && cost === config.maxFeeEnergy, {
      expected: "固定费用上限 === 最新真实报价（cap=q 绑定）",
      observed: `cap=${config.maxFeeEnergy} quote=${String(cost)}`,
    });
  }

  // ── time_stability：两个以上不同 tick、管理修改之后、暂停稳定、T 未错过 ────
  checks.boolean("time_stability", "facts_kind", facts.factsKind === "lab-calibration-facts", {
    expected: "lab-calibration-facts",
    observed: facts.factsKind,
  });
  checks.boolean("time_stability", "samples_two_ticks", new Set(ticks).size >= 2, {
    expected: "≥2 个互异 tick 的稳定基线",
    observed: JSON.stringify(ticks),
  });
  {
    const lastAdmin = facts.context.lastAdminChangeWallClock;
    const stamps = samples.map((sample) => sample.collectedAtWallClock ?? facts.context.collectedAtWallClock);
    if (!isNonEmptyString(lastAdmin)) {
      checks.add("time_stability", "collected_after_admin_change", "missing", { note: "facts 未声明最后管理修改时刻，无法核对基线新鲜度" });
    } else if (stamps.length === 0 || !stamps.every(isNonEmptyString)) {
      checks.add("time_stability", "collected_after_admin_change", "missing", { note: "样本采集时刻缺失，无法与管理修改时刻比较" });
    } else {
      const adminTime = Date.parse(lastAdmin);
      const sampleTimes = stamps.map((stamp) => Date.parse(stamp));
      const ok = Number.isFinite(adminTime) && sampleTimes.every((t) => Number.isFinite(t) && t > adminTime);
      checks.boolean("time_stability", "collected_after_admin_change", ok, {
        expected: `所有样本晚于最后管理修改 ${lastAdmin}`,
        observed: ok ? `最早样本 ${stamps[0]}` : JSON.stringify(stamps),
        note: Number.isFinite(adminTime) ? undefined : "管理修改时刻不可解析",
      });
    }
  }
  {
    const pausedOk = facts.context.paused === true && finiteNumber(facts.context.pauseConfirmedTick);
    checks.boolean("time_stability", "paused_confirmed", pausedOk && maxTick !== undefined && facts.context.pauseConfirmedTick === maxTick, {
      expected: "已暂停且 T0=最后基线 tick（重复只读核对后确认）",
      observed: `paused=${String(facts.context.paused)} pauseConfirmedTick=${String(facts.context.pauseConfirmedTick)} 最后样本 tick=${String(maxTick)}`,
    });
    const reachable = pausedOk && maxTick !== undefined && config.targetTick >= maxTick + 3 && config.targetTick > (facts.context.pauseConfirmedTick ?? Number.NEGATIVE_INFINITY);
    checks.boolean("time_stability", "target_tick_reachable", reachable, {
      expected: `T ≥ T0+3（T−2 样本可取得）且晚于暂停确认 tick；当前 T=${config.targetTick}`,
      observed: `最后样本 tick=${String(maxTick)} pauseConfirmedTick=${String(facts.context.pauseConfirmedTick)}`,
    });
  }

  // ── provenance：样本同源、采样器声明、配置代码来源可追溯 ────────────────────
  {
    const runIds = samples.map((sample) => sample.runId ?? facts.context.runId);
    const runIdOk = samples.length > 0 && isNonEmptyString(facts.context.runId) && runIds.every((id) => id === facts.context.runId);
    checks.boolean("provenance", "run_id_consistent", runIdOk, {
      expected: "所有样本与 context 同一 runId",
      observed: samples.length === 0 ? "无样本" : JSON.stringify([...new Set(runIds.map(String))]),
      note: runIdOk ? undefined : "不同运行/用户的资料混用或 runId 缺失",
    });
    const sampler = facts.context.sampler;
    checks.boolean("provenance", "sampler_declared", isNonEmptyString(String(sampler?.name ?? "")) && isNonEmptyString(String(sampler?.version ?? "")), {
      expected: "只读采样器名称与版本",
      observed: JSON.stringify(sampler),
    });
    const codeSource = facts.context.codeSource;
    if (isNonEmptyString(String(codeSource?.repoHead ?? "")) && isNonEmptyString(String(codeSource?.labConfigSha256 ?? ""))) {
      checks.boolean("provenance", "code_source", true, {
        observed: `repoHead=${String(codeSource?.repoHead)} labConfigSha256=${String(codeSource?.labConfigSha256)}`,
      });
    } else {
      checks.add("provenance", "code_source", "missing", { note: "配置代码来源（repoHead/labConfigSha256）缺失，无法追溯待验配置版本" });
    }
  }

  return checks.finish();
}
