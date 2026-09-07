/**
 * Core Candidate Seal I 测试专用证据模块（非 .test.ts，不被 Jest 收集；
 * 生产模块不得 import——test/typescriptConfigBoundaries.test.ts 守护）。
 *
 * 职责（Seal I/§2.4、§5）：
 * 1. H18 全程轨迹采集与导出：初始基线、逐 tick 重载前后、有限收尾、
 *    失败恢复与最终 close 的检查点流水 + 原始端口事件（计数一律来自
 *    实际事件求和，不按 stats.cleaned 或最终 outcome 事后推算）；
 * 2. outcome_unknown 风险事实的字段级基线比较：与活跃 Memory 脱离引用的
 *    深快照（JSON 往返，遇环抛错）+ 能定位 attemptId 与字段路径的差异；
 * 3. 轨迹完整性核验：缺中间窗口、缺终态、序号/段落数与执行时独立记录
 *    的次数不符、风险覆盖缺 ID、事件计数不一致都必须给出 problems。
 *
 * Evidence Remediation I（L01/L02/L03）补修：
 * - 原始风险事实经提取、序列化后不得丢失差异——字段缺失用显式哨兵
 *   SEAL_FIELD_ABSENT 表达，不再抹平成合法 null；基线建立时拒绝缺记录/
 *   缺字段的不完整事实（sealBuildUnknownRiskBaseline）；比较同时考虑
 *   存在性与值，且不忽略当前快照新增的风险字段键。
 * - 每个标准检查点必须用实际风险快照与独立基线逐字段重算——不信任
 *   riskCheckedIds/riskDiff 派生标签；中间漂移不因终态恢复放行；终态
 *   标签与 post-close 实际快照矛盾必须报错。
 *
 * 本模块自身无状态（可变状态只在 createSealTraceRecorder 返回的实例里），
 * 不受被测链路每 tick jest.resetModules 影响；文件写入仅发生在
 * TREASURY_SEAL_EVIDENCE_DIR 已设置且调用 sealWriteEvidence 时，未设置时
 * 全部断言照常、零 I/O。
 */

/** 一次外部消费者端口的原始调用事件（成功仅认原始布尔 true）。 */
export interface SealPortEvent {
  readonly seq: number;
  readonly tick: number;
  readonly key: string;
  readonly ok: boolean;
}

/** 单条风险事实差异：定位到 attempt 与字段路径，保留期望/实际原值。 */
export interface SealRiskDiff {
  readonly attemptId: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * 与任务书 Seal I/§2.3 对齐的风险字段白名单：exact attempt/workKey/
 * generation/parent 关联、完整 identity（含三摘要与 durable facts）、完整
 * worstCase 腿（逐腿金额，不只比总额或条数）、invocationBoundary/
 * invocation/external 原始事实（null 与缺失不得互替）、outcome/
 * outcomeEvidence/phase、尚存消费者义务及其归属。
 */
export const SEAL_RISK_FIELDS: readonly string[] = [
  "attemptId",
  "workKey",
  "generation",
  "parentAttemptId",
  "phase",
  "identity",
  "worstCase",
  "invocationBoundary",
  "invocation",
  "external",
  "outcome",
  "outcomeEvidence",
  "cleanup.consumerKeys",
];

/**
 * 字段缺失哨兵（Evidence Remediation I/§2.2）：原始记录上字段不存在（或
 * 显式 undefined）时，提取输出用该标记显式表达"缺失"——JSON 可表示、往返
 * 不变（NUL 控制字符不会出现在生产字段值里），不与任何合法原值混淆；与
 * "字段存在且值为 null"（合法原值）严格区分。diff/错误产物中渲染为
 * { sealFieldAbsent: true }，不会在 JSON 里消失成无法解释的标签。
 */
export const SEAL_FIELD_ABSENT = "\u0000seal-field-absent\u0000";

const sealRenderValue = (value: unknown): unknown =>
  value === SEAL_FIELD_ABSENT ? { sealFieldAbsent: true } : value;

const isMissingPlaceholder = (value: unknown): boolean =>
  value !== null && typeof value === "object" && "__missing__" in (value as Record<string, unknown>);

/**
 * 允许变化的纯诊断/调度元信息（不参与风险比较）：推进时间戳、最近错误
 * 文本、清理游标与失败计数、准入 tick 与重试期限（调度器自身的记账）。
 * 风险字段不得误归入此清单。
 */
export const SEAL_MUTABLE_DIAGNOSTIC_FIELDS: readonly string[] = [
  "admittedAtTick",
  "updatedAtTick",
  "lastError",
  "cleanup.cursor",
  "cleanup.failures",
  "retryDeadlineTick",
];

/**
 * 提取一条记录的风险事实子集（仅白名单字段；调用方负责快照脱离引用）。
 * Evidence Remediation I/§2.2：字段缺失（undefined）不再被抹平成合法
 * null——提取输出显式写缺失哨兵，"字段不存在"与"字段存在且值为 null"
 * 经提取、JSON 往返、比较后仍可区分。
 */
export function sealUnknownRiskOf(record: Record<string, unknown>): Record<string, unknown> {
  const at = (value: unknown): unknown => (value === undefined ? SEAL_FIELD_ABSENT : value);
  const cleanup = record.cleanup as { consumerKeys?: unknown } | null | undefined;
  let consumerKeys: unknown;
  if (cleanup === undefined || cleanup === null) {
    consumerKeys = SEAL_FIELD_ABSENT; // 消费者义务路径整体缺失
  } else if (Array.isArray(cleanup.consumerKeys)) {
    consumerKeys = [...cleanup.consumerKeys];
  } else {
    // consumerKeys=null 合法保留；undefined→哨兵；异常形状原样交给比较器暴露。
    consumerKeys = at(cleanup.consumerKeys);
  }
  return {
    attemptId: at(record.attemptId),
    workKey: at(record.workKey),
    generation: at(record.generation),
    parentAttemptId: at(record.parentAttemptId),
    phase: at(record.phase),
    identity: at(record.identity),
    worstCase: at(record.worstCase),
    invocationBoundary: at(record.invocationBoundary),
    invocation: at(record.invocation),
    external: at(record.external),
    outcome: at(record.outcome),
    outcomeEvidence: at(record.outcomeEvidence),
    "cleanup.consumerKeys": consumerKeys,
  };
}

/**
 * 为指定 attempt 集合生成与活跃 Memory 脱离引用的风险事实深快照
 * （JSON 往返；不保存活记录引用，不在比较时重建期望值）。
 */
export function sealSnapshotUnknownRisk(
  ids: readonly string[],
  active: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    const record = active[id];
    if (record === undefined) {
      out[id] = { __missing__: true };
      continue;
    }
    out[id] = JSON.parse(JSON.stringify(sealUnknownRiskOf(record))) as Record<string, unknown>;
  }
  return out;
}

/**
 * 建立独立风险基线（Evidence Remediation I/§2.2）：任何记录缺失（占位）
 * 或白名单风险字段在原始记录上不存在（哨兵）都明确拒绝——不能因基线与
 * 当前恰好缺了同一事实，就把不完整基线当"完整事实"参与比较。基线只生成
 * 一次、与 Memory 脱离引用；错误信息定位 attempt 与字段。
 */
export function sealBuildUnknownRiskBaseline(
  ids: readonly string[],
  active: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const snapshot = sealSnapshotUnknownRisk(ids, active);
  const missing: string[] = [];
  for (const id of ids) {
    const record = snapshot[id];
    if (record === undefined || isMissingPlaceholder(record)) {
      missing.push(`${id}: 记录缺失`);
      continue;
    }
    for (const field of SEAL_RISK_FIELDS) {
      const value = record[field];
      if (value === undefined) missing.push(`${id}.${field}: 提取输出缺字段`);
      else if (value === SEAL_FIELD_ABSENT) missing.push(`${id}.${field}: 原始记录上缺失`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`无法建立完整 unknown 风险基线（Evidence Remediation I/§2.2）: ${missing.join("; ")}`);
  }
  return snapshot;
}

function sealDeepDiff(
  attemptId: string,
  path: string,
  expected: unknown,
  actual: unknown,
  out: SealRiskDiff[],
): void {
  // diff 产物渲染哨兵为可解释标记：不能让缺失在错误 JSON 中消失成只剩标签。
  const emit = (field: string, exp: unknown, act: unknown): void => {
    out.push({ attemptId, field, expected: sealRenderValue(exp), actual: sealRenderValue(act) });
  };
  const bothObject =
    typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null;
  if (bothObject && Array.isArray(expected) === Array.isArray(actual)) {
    if (Array.isArray(expected) && Array.isArray(actual)) {
      if (expected.length !== actual.length) {
        emit(`${path}.length`, expected.length, actual.length);
        return;
      }
      expected.forEach((value, index) => sealDeepDiff(attemptId, `${path}[${index}]`, value, actual[index], out));
      return;
    }
    const expectedKeys = Object.keys(expected as Record<string, unknown>).sort();
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort();
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    for (const key of expectedKeys) {
      if (!(key in actualRecord)) emit(`${path}.${key} (missing)`, expectedRecord[key], undefined);
    }
    for (const key of actualKeys) {
      if (!(key in expectedRecord)) emit(`${path}.${key} (unexpected)`, undefined, actualRecord[key]);
    }
    for (const key of expectedKeys) {
      if (key in actualRecord) sealDeepDiff(attemptId, `${path}.${key}`, expectedRecord[key], actualRecord[key], out);
    }
    return;
  }
  if (expected !== actual) emit(path, expected, actual);
}

/**
 * 字段级比较当前风险事实与独立基线：返回差异清单（空数组=一致）。
 * null 与缺失不得互相替代：提取输出用 SEAL_FIELD_ABSENT 显式表达缺失，
 * 直接操作快照的副本删除键即为 undefined——两者都与基线合法 null 构成
 * 可定位差异。缺记录占位（__missing__）明确报整记录缺失，不把占位键
 * 当字段逐个比较；当前快照新增的风险字段键也不能被忽略（不能只遍历
 * 基线中恰好存在的键）。
 */
export function sealCompareUnknownRisk(
  baseline: Record<string, Record<string, unknown>>,
  current: Record<string, Record<string, unknown>>,
): SealRiskDiff[] {
  const diffs: SealRiskDiff[] = [];
  for (const id of Object.keys(baseline).sort()) {
    const expected = baseline[id];
    const actual = current[id];
    if (actual === undefined) {
      diffs.push({ attemptId: id, field: "(record)", expected: "present", actual: "missing" });
      continue;
    }
    if (isMissingPlaceholder(actual)) {
      diffs.push({ attemptId: id, field: "(record)", expected: isMissingPlaceholder(expected) ? "missing" : "present", actual: "missing" });
      continue;
    }
    if (isMissingPlaceholder(expected)) {
      diffs.push({ attemptId: id, field: "(record)", expected: "missing", actual: "present" });
      continue;
    }
    for (const field of Object.keys(expected).sort()) {
      sealDeepDiff(id, field, expected[field], actual[field], diffs);
    }
    for (const field of Object.keys(actual).sort()) {
      if (!(field in expected)) {
        diffs.push({ attemptId: id, field: `${field} (unexpected)`, expected: undefined, actual: sealRenderValue(actual[field]) });
      }
    }
  }
  return diffs;
}

export type SealTraceStage = "initial" | "observe" | "bounded" | "recovery" | "final-close";
export type SealTracePoint = "baseline" | "reload-before" | "after-advance" | "pre-close" | "post-close";

/** 检查点：一次重载后或推进后（或静态段）的完整观测。 */
export interface SealCheckpoint {
  readonly seq: number;
  readonly stage: SealTraceStage;
  readonly point: SealTracePoint;
  readonly tick: number;
  readonly health: string;
  readonly phases: Readonly<Record<string, number>>;
  readonly active: number;
  readonly ring: number;
  readonly remaining: number;
  readonly sharesUsed: number;
  readonly chars: number;
  readonly utf8Bytes: number;
  /** 本检查点生成时已发生的端口事件总数（实际事件计数）。 */
  readonly eventsUpTo: number;
  /** 本 tick 至此的实际事件求和（尝试/成功/失败分开）。 */
  readonly tickEvents: number;
  readonly tickSucceeded: number;
  readonly tickFailed: number;
  /** 本检查点 20 条 unknown 的实际风险事实（脱离引用深快照；终态/基线必备）。 */
  readonly unknownRisk: Readonly<Record<string, Record<string, unknown>>> | null;
  readonly riskCheckedIds: readonly string[] | null;
  /** 与独立基线的字段级比较结果：null=一致；非空=差异清单。 */
  readonly riskDiff: readonly SealRiskDiff[] | null;
  readonly note: string | null;
}

/** 每段执行时独立记录的实际迭代次数与终止原因（完整性核验交叉对象；段属性随段完成逐段填写）。 */
export interface SealSegmentFacts {
  observe: { plannedTicks: number; actualTicks: number; exitReason: string };
  bounded: { limitWindows: number; actualTicks: number; exitReason: string };
  recovery: { limitWindows: number; actualTicks: number; failingPortRestoredAtTick: number; exitReason: string };
}

export interface SealTraceDoc {
  readonly format: "treasury-seal-trace/v1";
  readonly suite: string;
  readonly test: string;
  readonly recordedAt: string;
  readonly comparisonScope: {
    readonly riskFieldsCompared: readonly string[];
    readonly mutableDiagnosticFieldsNotCompared: readonly string[];
  };
  readonly fixture: {
    readonly closing: number;
    readonly unknown: number;
    readonly retry: number;
    readonly pending: number;
    readonly obligations: number;
    readonly unknownIds: readonly string[];
  };
  readonly initial: {
    readonly health: string;
    readonly phases: Readonly<Record<string, number>>;
    readonly active: number;
    readonly ring: number;
    readonly remaining: number;
    readonly chars: number;
    readonly utf8Bytes: number;
    readonly unknownRiskBaseline: Readonly<Record<string, Record<string, unknown>>>;
  };
  segments: SealSegmentFacts;
  checkpoints: SealCheckpoint[];
  portEvents: SealPortEvent[];
  /** 显式业务命令（closeWork）与自动恢复预算内动作分开分类。 */
  finalClose: readonly { attemptId: string; status: string }[];
  terminal: {
    readonly health: string;
    readonly active: number;
    readonly unknownIds: readonly string[];
    readonly ring: number;
    readonly chars: number;
    readonly riskDiff: readonly SealRiskDiff[] | null;
  } | null;
  completed: boolean;
  failure: { stage: string; message: string } | null;
}

/** 测试侧传入的只读状态视图（测试用既有 h18StateOf/health 通道提供）。 */
export interface SealStateView {
  readonly health: string;
  readonly phases: Readonly<Record<string, number>>;
  readonly active: number;
  readonly ring: number;
  readonly remaining: number;
  readonly sharesUsed: number;
  readonly chars: number;
  readonly utf8Bytes: number;
  readonly activeRecords: Record<string, Record<string, unknown>>;
}

export interface SealTraceRecorder {
  /** 追加一个检查点（内部完成 unknown 风险快照与基线比较）。 */
  checkpoint(stage: SealTraceStage, point: SealTracePoint, note?: string): SealCheckpoint;
  setSegments(segments: SealSegmentFacts): void;
  addFinalClose(call: { attemptId: string; status: string }): void;
  /** 终态完成（不允许在 finally 里伪造；失败路径用 fail()）。 */
  complete(terminal: NonNullable<SealTraceDoc["terminal"]>): SealTraceDoc;
  /** 测试失败时标记不完整并定格已捕获轨迹（不补成功终态）。 */
  fail(stage: string, error: unknown): SealTraceDoc;
  /** 当前已定格或进行中的文档视图（用于失败导出）。 */
  current(): SealTraceDoc;
}

export function createSealTraceRecorder(init: {
  suite: string;
  test: string;
  fixture: SealTraceDoc["fixture"];
  unknownIds: readonly string[];
  portEvents: readonly SealPortEvent[];
  readState: () => SealStateView;
}): SealTraceRecorder {
  const firstState = init.readState();
  // Evidence Remediation I/§2.2：基线建立即拒绝缺记录/缺字段的不完整事实
  // （合法 null 保留）；此后任何检查点都不得从当前状态重建期望值。
  const baseline = sealBuildUnknownRiskBaseline(init.unknownIds, firstState.activeRecords);
  const doc: SealTraceDoc = {
    format: "treasury-seal-trace/v1",
    suite: init.suite,
    test: init.test,
    recordedAt: new Date().toISOString(),
    comparisonScope: {
      riskFieldsCompared: SEAL_RISK_FIELDS,
      mutableDiagnosticFieldsNotCompared: SEAL_MUTABLE_DIAGNOSTIC_FIELDS,
    },
    fixture: init.fixture,
    initial: {
      health: firstState.health,
      phases: firstState.phases,
      active: firstState.active,
      ring: firstState.ring,
      remaining: firstState.remaining,
      chars: firstState.chars,
      utf8Bytes: firstState.utf8Bytes,
      unknownRiskBaseline: baseline,
    },
    segments: {
      observe: { plannedTicks: 0, actualTicks: 0, exitReason: "not-run" },
      bounded: { limitWindows: 0, actualTicks: 0, exitReason: "not-run" },
      recovery: { limitWindows: 0, actualTicks: 0, failingPortRestoredAtTick: -1, exitReason: "not-run" },
    },
    checkpoints: [],
    portEvents: init.portEvents as SealPortEvent[],
    finalClose: [],
    terminal: null,
    completed: false,
    failure: null,
  };
  let checkpointSeq = 0;
  function riskCheck(state: SealStateView): {
    unknownRisk: Record<string, Record<string, unknown>> | null;
    riskCheckedIds: string[] | null;
    riskDiff: SealRiskDiff[] | null;
  } {
    const snapshot = sealSnapshotUnknownRisk(init.unknownIds, state.activeRecords);
    const diffs = sealCompareUnknownRisk(baseline, snapshot);
    return { unknownRisk: snapshot, riskCheckedIds: [...init.unknownIds], riskDiff: diffs.length === 0 ? null : diffs };
  }
  return {
    checkpoint(stage, point, note) {
      checkpointSeq += 1;
      const state = init.readState();
      const tick = (globalThis as unknown as { Game?: { time: number } }).Game?.time ?? -1;
      const events = doc.portEvents;
      let tickEvents = 0;
      let tickSucceeded = 0;
      let tickFailed = 0;
      for (const event of events) {
        if (event.tick === tick) {
          tickEvents += 1;
          if (event.ok) tickSucceeded += 1;
          else tickFailed += 1;
        }
      }
      const risk = riskCheck(state);
      const checkpoint: SealCheckpoint = {
        seq: checkpointSeq,
        stage,
        point,
        tick,
        health: state.health,
        phases: state.phases,
        active: state.active,
        ring: state.ring,
        remaining: state.remaining,
        sharesUsed: state.sharesUsed,
        chars: state.chars,
        utf8Bytes: state.utf8Bytes,
        eventsUpTo: events.length,
        tickEvents,
        tickSucceeded,
        tickFailed,
        unknownRisk: risk.unknownRisk,
        riskCheckedIds: risk.riskCheckedIds,
        riskDiff: risk.riskDiff,
        note: note ?? null,
      };
      doc.checkpoints.push(checkpoint);
      return checkpoint;
    },
    setSegments(segments) {
      doc.segments = segments;
    },
    addFinalClose(call) {
      doc.finalClose = [...doc.finalClose, call];
    },
    complete(terminal) {
      doc.terminal = terminal;
      doc.completed = true;
      return doc;
    },
    fail(stage, error) {
      doc.failure = { stage, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      doc.completed = false;
      return doc;
    },
    current() {
      return doc;
    },
  };
}

/**
 * 有界完整性核验（Seal I/§2.4）：初始、全部观察窗口、全部追加窗口、
 * 失败恢复、终态都在；序号及段落数与执行时独立记录的次数相符；风险
 * 比较覆盖所有 unknown ID；事件计数来自实际事件求和且相互一致。
 * 返回 problems 清单（空数组=通过）——绝不抛错吞掉具体缺失项。
 */
export function sealVerifyTraceCompleteness(
  trace: SealTraceDoc,
  expected: { unknownIds: readonly string[]; plannedObserveTicks: number },
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const push = (problem: string): void => {
    problems.push(problem);
  };
  if (trace.format !== "treasury-seal-trace/v1") push(`format 不符: ${String(trace.format)}`);
  if (!trace.completed) push("completed=false（轨迹未完整定格）");
  const expectedIds = [...expected.unknownIds].sort();
  const sameIds = (ids: readonly string[]): boolean => JSON.stringify([...ids].sort()) === JSON.stringify(expectedIds);
  // —— 基线完整性（Evidence Remediation I/§3.2）：缺记录占位或白名单字段
  //    缺失/哨兵的基线不是"完整事实"——基线与当前恰好都缺同一风险事实不
  //    构成完整；合法 null 是实际取值，允许。不能从检查点标签临时改出更小
  //    的 expected 集合。
  if (!trace.initial || !trace.initial.unknownRiskBaseline) push("initial/基线缺失");
  else if (!sameIds(Object.keys(trace.initial.unknownRiskBaseline))) push("initial 基线未覆盖全部 unknown ID");
  else {
    for (const [id, record] of Object.entries(trace.initial.unknownRiskBaseline)) {
      if (isMissingPlaceholder(record)) {
        push(`initial 基线 ${id} 为缺记录占位——缺记录不能当完整基线`);
        continue;
      }
      for (const field of SEAL_RISK_FIELDS) {
        if (!(field in record)) push(`initial 基线 ${id} 缺风险字段 ${field}——基线与当前都缺同一事实不构成完整`);
        else if (record[field] === SEAL_FIELD_ABSENT) push(`initial 基线 ${id}.${field} 为缺失哨兵——原始风险事实缺失，不得建立完整基线`);
      }
    }
  }
  const baselineForRecheck =
    trace.initial && trace.initial.unknownRiskBaseline && sameIds(Object.keys(trace.initial.unknownRiskBaseline))
      ? (trace.initial.unknownRiskBaseline as Record<string, Record<string, unknown>>)
      : undefined;
  const checkpoints = trace.checkpoints;
  checkpoints.forEach((checkpoint, index) => {
    if (checkpoint.seq !== index + 1) push(`检查点序号不连续: 位置 ${index} seq=${checkpoint.seq}`);
  });
  const stageTicks = (stage: SealTraceStage): number[] => checkpoints.filter((c) => c.stage === stage).map((c) => c.tick);
  const pairsOf = (stage: SealTraceStage): Map<number, { before?: number; after?: number }> => {
    const map = new Map<number, { before?: number; after?: number }>();
    for (const c of checkpoints.filter((x) => x.stage === stage)) {
      const entry = map.get(c.tick) ?? {};
      if (c.point === "reload-before") entry.before = (entry.before ?? 0) + 1;
      if (c.point === "after-advance") entry.after = (entry.after ?? 0) + 1;
      map.set(c.tick, entry);
    }
    return map;
  };
  const observe = trace.segments.observe;
  const observeTicks = [...new Set(stageTicks("observe"))];
  const observeAfter = checkpoints.filter((c) => c.stage === "observe" && c.point === "after-advance");
  if (observeAfter.length !== observe.actualTicks) push(`observe 段 after-advance 检查点数 ${observeAfter.length} ≠ 执行记录 actualTicks ${observe.actualTicks}`);
  if (observeTicks.length !== observe.actualTicks) push(`observe 段实际窗口数 ${observeTicks.length} ≠ ${observe.actualTicks}`);
  if (observe.actualTicks !== expected.plannedObserveTicks) push(`observe 段 ${observe.actualTicks} 窗口 ≠ 计划 ${expected.plannedObserveTicks}`);
  for (const [tick, pair] of pairsOf("observe")) {
    if (pair.before !== 1 || pair.after !== 1) push(`observe tick ${tick} 重载前/推进后未成对 (before=${pair.before ?? 0}, after=${pair.after ?? 0})`);
  }
  const bounded = trace.segments.bounded;
  const boundedAfter = checkpoints.filter((c) => c.stage === "bounded" && c.point === "after-advance");
  const boundedTicks = [...new Set(stageTicks("bounded"))];
  if (boundedAfter.length !== bounded.actualTicks) push(`bounded 段 after-advance 检查点数 ${boundedAfter.length} ≠ actualTicks ${bounded.actualTicks}`);
  if (boundedTicks.length !== bounded.actualTicks) push(`bounded 段实际窗口数 ${boundedTicks.length} ≠ ${bounded.actualTicks}`);
  if (bounded.actualTicks > bounded.limitWindows) push(`bounded 段 ${bounded.actualTicks} 窗口超过限值 ${bounded.limitWindows}`);
  for (const [tick, pair] of pairsOf("bounded")) {
    if (pair.before !== 1 || pair.after !== 1) push(`bounded tick ${tick} 未成对`);
  }
  const recovery = trace.segments.recovery;
  const recoveryAfter = checkpoints.filter((c) => c.stage === "recovery" && c.point === "after-advance");
  const recoveryTicks = [...new Set(stageTicks("recovery"))];
  if (recoveryAfter.length !== recovery.actualTicks) push(`recovery 段检查点数 ${recoveryAfter.length} ≠ actualTicks ${recovery.actualTicks}`);
  if (recoveryTicks.length !== recovery.actualTicks) push(`recovery 段实际窗口数 ${recoveryTicks.length} ≠ ${recovery.actualTicks}`);
  if (recovery.actualTicks > recovery.limitWindows) push(`recovery 段 ${recovery.actualTicks} 窗口超过限值 ${recovery.limitWindows}`);
  for (const [tick, pair] of pairsOf("recovery")) {
    if (pair.before !== 1 || pair.after !== 1) push(`recovery tick ${tick} 未成对`);
  }
  if (checkpoints.every((c) => c.stage !== "final-close" || c.point !== "pre-close")) push("final-close 段缺 pre-close 检查点");
  if (checkpoints.every((c) => c.stage !== "final-close" || c.point !== "post-close")) push("final-close 段缺 post-close 检查点（终态丢失）");
  let lastUpTo = 0;
  for (const checkpoint of checkpoints) {
    if (checkpoint.eventsUpTo < lastUpTo) push(`检查点 seq=${checkpoint.seq} eventsUpTo 回退`);
    lastUpTo = checkpoint.eventsUpTo;
  }
  const finalCheckpoint = checkpoints[checkpoints.length - 1];
  if (finalCheckpoint && finalCheckpoint.eventsUpTo !== trace.portEvents.length) {
    push(`末检查点 eventsUpTo ${finalCheckpoint.eventsUpTo} ≠ 端口事件总数 ${trace.portEvents.length}`);
  }
  trace.portEvents.forEach((event, index) => {
    if (event.seq !== index + 1) push(`端口事件序号不连续: 位置 ${index} seq=${event.seq}`);
  });
  for (const checkpoint of checkpoints) {
    if (checkpoint.point !== "after-advance" && checkpoint.point !== "post-close") continue;
    const upto = trace.portEvents.filter((event) => event.seq <= checkpoint.eventsUpTo && event.tick === checkpoint.tick);
    const succeeded = upto.filter((event) => event.ok).length;
    const failed = upto.length - succeeded;
    if (upto.length !== checkpoint.tickEvents || succeeded !== checkpoint.tickSucceeded || failed !== checkpoint.tickFailed) {
      push(`检查点 seq=${checkpoint.seq} tick ${checkpoint.tick} 事件计数与实际事件求和不符`);
    }
  }
  // —— 逐检查点实证核验（Evidence Remediation I/§3.2）：每个标准检查点
  //    （observe/bounded/recovery 的 reload-before/after-advance 与
  //    final-close 的 pre-close/post-close）必须有实际风险快照（非 null、
  //    覆盖 expected ID 集合、无缺记录占位），并与独立基线逐字段重算——
  //    不信任 riskCheckedIds/riskDiff 派生标签；中间发生过风险变化、后面
  //    变回去也不能让保留性验收通过。仅有覆盖标签不等于有实际风险数据。
  //    核验纯读：不修改轨迹、不补 null/缺字段、不从邻近检查点或 Memory
  //    补回证据。
  for (const checkpoint of checkpoints) {
    const standard =
      ((checkpoint.stage === "observe" || checkpoint.stage === "bounded" || checkpoint.stage === "recovery") &&
        (checkpoint.point === "reload-before" || checkpoint.point === "after-advance")) ||
      (checkpoint.stage === "final-close" && (checkpoint.point === "pre-close" || checkpoint.point === "post-close"));
    if (!standard) continue;
    const where = `检查点 seq=${checkpoint.seq}（${checkpoint.stage}/${checkpoint.point} tick ${checkpoint.tick}）`;
    if (checkpoint.unknownRisk === null) {
      push(`${where} 风险证据缺失（unknownRisk=null；仅 riskCheckedIds 覆盖标签不构成实际风险数据）`);
      if (checkpoint.riskDiff !== null && checkpoint.riskDiff.length > 0) {
        push(`${where} 无实际风险快照但 riskDiff 标签非空（标签无原始证据支持）`);
      }
      continue;
    }
    const snapshot = checkpoint.unknownRisk as Record<string, Record<string, unknown>>;
    const coveredIds = Object.keys(snapshot);
    if (!sameIds(coveredIds)) {
      push(`${where} 实际风险快照未覆盖全部 unknown ID（覆盖 ${coveredIds.length}/${expectedIds.length}）`);
      continue;
    }
    if (baselineForRecheck === undefined) continue; // 基线问题已在前面报告
    const recheck = sealCompareUnknownRisk(baselineForRecheck, snapshot);
    if (recheck.length > 0) {
      const first = recheck[0];
      if (first === undefined) {
        push(`${where} 风险与基线重算存在差异（无法定位首条）`);
      } else {
        push(`${where} 风险与基线重算存在差异（中间漂移不因后续恢复放行）: ${first.attemptId}.${first.field} expected=${JSON.stringify(first.expected)} actual=${JSON.stringify(first.actual)}${recheck.length > 1 ? `（共 ${recheck.length} 条）` : ""}`);
      }
    }
    // 派生标签必须与实际重算一致：riskDiff=null 语义是"重算后无差异"，
    // 不是缺少 unknownRisk 的合法理由；标签非空而重算一致也是矛盾。
    const labelEmpty = checkpoint.riskDiff === null || (Array.isArray(checkpoint.riskDiff) && checkpoint.riskDiff.length === 0);
    if (recheck.length === 0 && !labelEmpty) push(`${where} riskDiff 标签非空但实际快照与基线重算一致（标签与实际证据矛盾）`);
    if (recheck.length > 0 && labelEmpty) push(`${where} riskDiff 标签报告一致但实际快照与基线重算存在差异（标签与实际证据矛盾）`);
    if (checkpoint.riskCheckedIds !== null && !sameIds(checkpoint.riskCheckedIds)) {
      push(`${where} 风险比较覆盖标签与 expected ID 集合不符`);
    }
  }
  if (trace.terminal === null) {
    push("terminal 缺失");
  } else {
    if (!sameIds(trace.terminal.unknownIds)) push("terminal unknown ID 集合与预期不符");
    if (trace.terminal.active !== expected.unknownIds.length) push(`terminal active ${trace.terminal.active} ≠ ${expected.unknownIds.length}`);
    if (trace.terminal.riskDiff !== null && trace.terminal.riskDiff.length > 0) push("terminal 风险事实与基线存在差异");
    // —— 终态标签与 post-close 实际快照交叉（Evidence Remediation I/§3.2）：
    //    终态结论复用已核验的 post-close 快照作为实际内容支持；两者矛盾
    //    必须报错，不能静默采信终态标签。
    const postClose = checkpoints.find((c) => c.stage === "final-close" && c.point === "post-close");
    if (postClose !== undefined && postClose.unknownRisk !== null && baselineForRecheck !== undefined) {
      const postDiffs = sealCompareUnknownRisk(baselineForRecheck, postClose.unknownRisk as Record<string, Record<string, unknown>>);
      const terminalEmpty = trace.terminal.riskDiff === null || trace.terminal.riskDiff.length === 0;
      if (postDiffs.length === 0 && !terminalEmpty) push("terminal.riskDiff 标签非空但 post-close 实际快照与基线重算一致（终态标签与实际证据矛盾）");
      if (postDiffs.length > 0 && terminalEmpty) push("post-close 实际快照与基线重算存在差异但 terminal.riskDiff 标签报告一致（终态标签与实际证据矛盾）");
    }
  }
  if (trace.finalClose.length === 0) push("finalClose 为空（retry_ready 退出无真实 closeWork 调用记录）");
  return { ok: problems.length === 0, problems };
}

const SEAL_RUN_STAMP = `${Date.now()}-${process.pid}`;

/**
 * 导出一份轨迹到 TREASURY_SEAL_EVIDENCE_DIR 指定根目录下的本次运行独立
 * 子目录（每次 Jest 进程一个目录，避免定向/Treasury/全仓/复验互相覆盖）。
 * baseDir 未设置时返回 null——断言照常，仅不落盘。证据路径错误向上抛出，
 * 不静默丢弃。
 */
export function sealWriteEvidence(
  baseDir: string | undefined,
  doc: SealTraceDoc,
  testId: string,
): { runDir: string; file: string } | null {
  if (!baseDir) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  const runDir = nodePath.join(baseDir, SEAL_RUN_STAMP);
  nodeFs.mkdirSync(runDir, { recursive: true });
  const file = nodePath.join(runDir, `${testId}.json`);
  nodeFs.writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`, "utf8");
  return { runDir, file };
}
