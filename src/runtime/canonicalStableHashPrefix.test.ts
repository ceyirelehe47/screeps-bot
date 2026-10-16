import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";

// 固定摘要来自优化前的 v1 实现；覆盖 UTF-16、前中后变更与 64 Ki 上限。
const vectors = [
  [1, 12000, 0, "csh1:690839f46103d6728456533d8e052863"],
  [2, 12000, 0, "csh1:b2ea9a12d62fa2abb2d0545b80861823"],
  [2, 12000, 1, "csh1:f0d55ceb88232fdba5119e4035ccfa1f"],
  [2, 12000, 2, "csh1:6e9d44ff05f9f0b35a42d2c55e8d0c9f"],
  [2, 12000, 3, "csh1:5ac1c6b0dd006f633bdd8af0ad6bb56a"],
  [2, 65536, 0, "csh1:d276b1416b62fd79544ba58db19729c9"],
  [2, 70000, 0, "csh1:e78263ecaf721e097a3448ab84aecb76"],
  [3, 100, 0, "csh1:75f414e783b633fa858c1aeb8e5ca7ce"],
] as const;

function fixture(seed: number, length: number, variant = 0) {
  let payload = (`历史🙂${seed % 3}`)
    .repeat(Math.ceil(length / 5))
    .slice(0, length);
  if (variant !== 0) {
    const index =
      variant === 1 ? 0 : variant === 2 ? Math.floor(length / 2) : length - 1;
    payload = `${payload.slice(0, index)}改${payload.slice(index + 1)}`;
  }
  return { domain: "canonical-prefix-regression-v1", payload, updatedAt: seed };
}

describe("canonical v1 长前缀复用", () => {
  it("Memory 重解析后的等值大输入复用完整摘要，原地变更仍立即失效", () => {
    const value = fixture(2, 70000);
    expect(canonicalStableHashV1(value)).toBe(vectors[6][3]);
    const reloaded = JSON.parse(JSON.stringify(value));
    const imul = jest.spyOn(Math, "imul");
    try {
      expect(canonicalStableHashV1(reloaded)).toBe(vectors[6][3]);
      expect(imul).not.toHaveBeenCalled();
    } finally {
      imul.mockRestore();
    }
    reloaded.payload = `${reloaded.payload.slice(0, -1)}改`;
    expect(canonicalStableHashV1(reloaded)).not.toBe(vectors[6][3]);
    reloaded.updatedAt = Infinity;
    expect(() => canonicalStableHashV1(reloaded)).toThrow(TypeError);
  });

  it.each(vectors)(
    "保持旧摘要：seed=%i length=%i variant=%i",
    (seed, length, variant, expected) => {
      canonicalStableHashV1(fixture(seed, length));
      expect(canonicalStableHashV1(fixture(seed, length, variant))).toBe(expected);
    },
  );

  it("原地尾部修改不能复用旧摘要，键顺序仍规范化", () => {
    const value = fixture(1, 12000);
    canonicalStableHashV1(value);
    Object.assign(value, fixture(2, 12000));
    expect(canonicalStableHashV1(value)).toBe(vectors[1][3]);
    expect(
      canonicalStableHashV1({
        updatedAt: value.updatedAt,
        payload: value.payload,
        domain: value.domain,
      }),
    ).toBe(vectors[1][3]);
    value.payload = fixture(2, 12000, 3).payload;
    expect(canonicalStableHashV1(value)).toBe(vectors[4][3]);
  });

  it("缓存被其他长前缀替换后仍保持旧摘要", () => {
    canonicalStableHashV1(fixture(2, 70000));
    for (let index = 0; index < 12; index += 1) {
      canonicalStableHashV1({ domain: `evict-${index}`, payload: "长".repeat(9000) });
    }
    expect(canonicalStableHashV1(fixture(2, 70000))).toBe(vectors[6][3]);
  });

  it("浅冻结对象的可变子对象仍重新读取", () => {
    const nested = { updatedAt: 1 };
    const value = Object.freeze({ payload: "长".repeat(9000), nested });
    const before = canonicalStableHashV1(value);
    nested.updatedAt = 2;
    const after = canonicalStableHashV1(value);
    expect(after).not.toBe(before);
    expect(after).toBe(
      canonicalStableHashV1({ nested: { updatedAt: 2 }, payload: value.payload }),
    );
  });

  it("命中前缀也必须拒绝当前输入的非有限数与 undefined", () => {
    const value: Record<string, unknown> = fixture(2, 12000);
    canonicalStableHashV1(value);
    for (const invalid of [NaN, Infinity, -Infinity, undefined]) {
      value.updatedAt = invalid;
      expect(() => canonicalStableHashV1(value)).toThrow(TypeError);
    }
  });

  it("命中前缀也必须拒绝循环与非普通对象", () => {
    const value: Record<string, unknown> = fixture(2, 12000);
    canonicalStableHashV1(value);
    value.updatedAt = value;
    expect(() => canonicalStableHashV1(value)).toThrow("cycle");
    value.updatedAt = new Date(0);
    expect(() => canonicalStableHashV1(value)).toThrow("plain objects");
  });
});
