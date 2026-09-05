/**
 * Treasury canonical transaction identity 固定 test vectors（第五轮）：
 * - 分命名空间：stable（ts1_）与 per-tick（tt1_）前缀不同且不可碰撞；
 * - canonical 编码：number 42 与 string "42" 不碰撞、元组边界不碰撞、
 *   字段顺序敏感、attempt sequence 敏感；
 * - 输入域：Unicode/空格/冒号/空字符串均可作为业务字段；超长字段仍产出
 *   固定长度合法 id；
 * - 稳定性：相同输入跨 tick 恒定、不依赖随机数；输出恒过 validator；
 * - 固定 vectors 防实现未来漂移（变更 hash/编码必须显式更新此处并升版本头）；
 * - payload digest：相同载荷同 digest、posting 顺序规范化、任一字段变化
 *   → 不同 digest。
 */
import {
  encodeTreasuryCanonicalTuple,
  formatTreasuryStableTransactionId,
  formatTreasuryTransactionId,
  hashTreasuryCanonicalString,
  isValidTreasuryTransactionId,
} from "@/runtime/treasury/transactionId";
import {
  buildTreasuryCanonicalTransaction,
  computeTreasuryPayloadDigest,
} from "@/runtime/treasury/canonicalTransaction";

/** 固定 vectors：编码 + hash 实现的锚点（漂移即红）。 */
const STABLE_VECTORS: ReadonlyArray<{ input: Array<string | number>; expected: string }> = [
  { input: ["deal", "order-1"], expected: "ts1_92041c3e9c930910" },
  { input: ["deal", "order-1", 7], expected: "ts1_9d81bc6bb91135b6" },
  { input: ["mkt", "W1N57", "order-9", 7], expected: "ts1_2cd3c326b3659d80" },
  { input: ["a", "b:c"], expected: "ts1_673ab01bb6b2039e" },
  { input: ["a:b", "c"], expected: "ts1_eca51597ca2cebb2" },
  { input: ["x", 42], expected: "ts1_5d59e047edd18c64" },
  { input: ["x", "42"], expected: "ts1_e7d9924e0cbd8798" },
  { input: ["kind", ""], expected: "ts1_e1e5584356b2e176" },
  { input: ["kind", "中文/空格 字段"], expected: "ts1_8ca942ce38413e34" },
  { input: ["kind", "a".repeat(500)], expected: "ts1_4b75b3860aae29bc" },
  { input: ["kind", "b", "c"], expected: "ts1_d9ea6693ac63fe22" },
  { input: ["kind", "c", "b"], expected: "ts1_b8b83a29ee03245a" },
];

describe("Treasury canonical transactionId 固定 vectors", () => {
  it.each(STABLE_VECTORS)("vector %j → %s", ({ input, expected }) => {
    expect(formatTreasuryStableTransactionId(input[0] as string, ...(input.slice(1) as Array<string | number>))).toBe(expected);
  });

  it("相同输入重复调用恒定（无随机性）", () => {
    expect(formatTreasuryStableTransactionId("deal", "order-1")).toBe("ts1_92041c3e9c930910");
    expect(formatTreasuryStableTransactionId("deal", "order-1")).toBe("ts1_92041c3e9c930910");
  });

  it("输出恒过 transactionId validator 且定长", () => {
    for (const { input } of STABLE_VECTORS) {
      const id = formatTreasuryStableTransactionId(input[0] as string, ...(input.slice(1) as Array<string | number>));
      expect(isValidTreasuryTransactionId(id)).toBe(true);
      expect(id.length).toBe(20); // ts1_ + 16 hex
    }
    const long = formatTreasuryStableTransactionId("kind", "x".repeat(10_000), 123, "尾部");
    expect(isValidTreasuryTransactionId(long)).toBe(true);
    expect(long.length).toBe(20);
  });

  it("number 42 与 string \"42\" 不碰撞", () => {
    expect(formatTreasuryStableTransactionId("x", 42)).not.toBe(formatTreasuryStableTransactionId("x", "42"));
  });

  it("元组边界不碰撞（冒号作为业务字段合法）", () => {
    expect(formatTreasuryStableTransactionId("a", "b:c")).not.toBe(formatTreasuryStableTransactionId("a:b", "c"));
  });

  it("字段顺序敏感与 attempt sequence 敏感", () => {
    expect(formatTreasuryStableTransactionId("kind", "b", "c")).not.toBe(formatTreasuryStableTransactionId("kind", "c", "b"));
    expect(formatTreasuryStableTransactionId("deal", "order-1")).not.toBe(formatTreasuryStableTransactionId("deal", "order-1", 7));
  });

  it("空字符串作为业务字段合法且与缺失字段不碰撞", () => {
    expect(formatTreasuryStableTransactionId("kind", "")).not.toBe(formatTreasuryStableTransactionId("kind"));
  });

  it("非法数字成分抛错（负数/NaN/Infinity/非整数/非安全整数）", () => {
    expect(() => formatTreasuryStableTransactionId("k", -1)).toThrow();
    expect(() => formatTreasuryStableTransactionId("k", Number.NaN)).toThrow();
    expect(() => formatTreasuryStableTransactionId("k", Number.POSITIVE_INFINITY)).toThrow();
    expect(() => formatTreasuryStableTransactionId("k", 1.5)).toThrow();
    expect(() => formatTreasuryStableTransactionId("k", Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => formatTreasuryTransactionId("k", -1)).toThrow();
  });

  it("stable 与 per-tick 命名空间不碰撞（不同前缀 + tick 参与 tuple）", () => {
    Game.time = 100_000;
    const stable = formatTreasuryStableTransactionId("deal", "order-1");
    const tick = formatTreasuryTransactionId("deal", "order-1");
    expect(stable).toBe("ts1_92041c3e9c930910");
    expect(tick).toBe("tt1_100000_b32fa04d25d42668");
    expect(stable).not.toBe(tick);
    expect(stable.startsWith("ts1_")).toBe(true);
    expect(tick.startsWith("tt1_")).toBe(true);
  });

  it("per-tick id 跨 tick 变化（tick 分量参与 canonical tuple）", () => {
    Game.time = 100_000;
    const first = formatTreasuryTransactionId("deal", "order-1");
    Game.time = 100_001;
    const second = formatTreasuryTransactionId("deal", "order-1");
    expect(first).not.toBe(second);
    expect(second.startsWith("tt1_100001_")).toBe(true);
  });

  it("stable id 跨 tick 恒定（不含 tick 分量）", () => {
    Game.time = 100_000;
    const first = formatTreasuryStableTransactionId("deal", "order-1");
    Game.time = 200_000;
    expect(formatTreasuryStableTransactionId("deal", "order-1")).toBe(first);
  });

  it("canonical tuple 编码可区分类型与边界", () => {
    expect(encodeTreasuryCanonicalTuple(["x", 42])).not.toBe(encodeTreasuryCanonicalTuple(["x", "42"]));
    expect(encodeTreasuryCanonicalTuple(["a", "b:c"])).not.toBe(encodeTreasuryCanonicalTuple(["a:b", "c"]));
    expect(encodeTreasuryCanonicalTuple(["kind", "b", "c"])).not.toBe(encodeTreasuryCanonicalTuple(["kind", "c", "b"]));
    expect(hashTreasuryCanonicalString(encodeTreasuryCanonicalTuple(["deal", "order-1"]))).toBe("92041c3e9c930910");
  });
});

describe("Treasury payload digest", () => {
  const baseInput = {
    transactionId: "ts1_92041c3e9c930910",
    kind: "terminal.send",
    source: "test",
    decision: { scope: "shared" as const, epochSeq: 1, observedAtTick: 100_000 },
    postings: [
      { roomName: "W1N57", locationKind: "storage" as const, resource: "energy", delta: -500 },
      { roomName: "W1N57", locationKind: "terminal" as const, resource: "energy", delta: 500 },
    ],
  };

  it("相同载荷 digest 恒定且 posting 顺序规范化", () => {
    const first = computeTreasuryPayloadDigest(buildTreasuryCanonicalTransaction(baseInput));
    const reordered = {
      ...baseInput,
      postings: [...baseInput.postings].reverse(),
    };
    expect(computeTreasuryPayloadDigest(buildTreasuryCanonicalTransaction(reordered))).toBe(first);
    expect(computeTreasuryPayloadDigest(buildTreasuryCanonicalTransaction(baseInput))).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each([
    ["kind 变化", { ...baseInput, kind: "market.deal" }],
    ["source 变化", { ...baseInput, source: "other" }],
    ["transactionId 变化", { ...baseInput, transactionId: "ts1_deadbeefdeadbeef" }],
    ["epochSeq 变化", { ...baseInput, decision: { ...baseInput.decision, epochSeq: 2 } }],
    ["postings 内容变化", { ...baseInput, postings: [{ ...baseInput.postings[0], delta: -501 }, baseInput.postings[1]] }],
  ])("%s → digest 不同", (_label, mutated) => {
    const base = computeTreasuryPayloadDigest(buildTreasuryCanonicalTransaction(baseInput));
    expect(computeTreasuryPayloadDigest(buildTreasuryCanonicalTransaction(mutated))).not.toBe(base);
  });

  it("canonical snapshot 深复制：修改原 input 不影响 snapshot", () => {
    const mutable = {
      ...baseInput,
      postings: baseInput.postings.map((p) => ({ ...p })),
    };
    const canonical = buildTreasuryCanonicalTransaction(mutable);
    (mutable.postings[0] as { delta: number }).delta = -9_999;
    (mutable as { kind: string }).kind = "mutated";
    expect(canonical.postings[0].delta).toBe(-500);
    expect(canonical.kind).toBe("terminal.send");
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.postings)).toBe(true);
    expect(Object.isFrozen(canonical.postings[0])).toBe(true);
  });
});
