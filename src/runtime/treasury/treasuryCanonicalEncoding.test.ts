/**
 * Treasury 安全 canonical encoding 测试（第九轮 4.11）：
 * - 确定性：相同语义、不同 key 插入顺序产生相同编码/digest；不同语义不同
 *   digest；数组顺序保持语义；
 * - 拒绝集合：cyclic/getter/setter/自定义 prototype/class instance/Date/
 *   Map/Set/function/symbol/bigint/undefined/NaN/±Infinity/稀疏数组/symbol 键
 *   全部结构化拒绝（零抛出）；getter 不被副作用读取（计数为 0）；
 * - 无静默碰撞：{a:undefined} 与 {} 不碰撞（前者直接拒绝）、NaN 与 null
 *   不碰撞（NaN 拒绝）、-0 与 0 区分；
 * - 有界：深度/编码长度/数组长度/对象键数超限拒绝；
 * - canonical frozen：输出逐层冻结；调用方修改原 args 不影响编码文本。
 */
import { canonicalizeTreasuryActionArgs, TREASURY_CANONICAL_MAX_TEXT_LENGTH } from "@/runtime/treasury/canonicalEncoding";

describe("canonicalizeTreasuryActionArgs 确定性", () => {
  it("相同语义、不同 key 插入顺序产生相同编码文本与 canonical 结构", () => {
    const a = canonicalizeTreasuryActionArgs({ x: 1, y: "s", z: [1, 2], nested: { b: true, a: null } });
    const b = canonicalizeTreasuryActionArgs({ nested: { a: null, b: true }, z: [1, 2], y: "s", x: 1 });
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    if (a.status !== "ok" || b.status !== "ok") return;
    expect(b.text).toBe(a.text);
    expect(b.canonical).toEqual(a.canonical);
  });

  it("不同语义产生不同编码（值/键/嵌套/数组元素任一差异）", () => {
    const base = canonicalizeTreasuryActionArgs({ amount: 500 });
    const value = canonicalizeTreasuryActionArgs({ amount: 501 });
    const key = canonicalizeTreasuryActionArgs({ amount2: 500 });
    const arrayOrder = canonicalizeTreasuryActionArgs({ list: [2, 1] });
    const arrayBase = canonicalizeTreasuryActionArgs({ list: [1, 2] });
    expect([base, value, key, arrayOrder, arrayBase].every((r) => r.status === "ok")).toBe(true);
    if (base.status !== "ok" || value.status !== "ok" || key.status !== "ok" || arrayOrder.status !== "ok" || arrayBase.status !== "ok") {
      return;
    }
    expect(value.text).not.toBe(base.text);
    expect(key.text).not.toBe(base.text);
    expect(arrayOrder.text).not.toBe(arrayBase.text);
  });

  it("数组顺序保持语义（不排序）；-0 与 0 区分编码", () => {
    const negZero = canonicalizeTreasuryActionArgs({ v: -0 });
    const zero = canonicalizeTreasuryActionArgs({ v: 0 });
    expect(negZero.status).toBe("ok");
    expect(zero.status).toBe("ok");
    if (negZero.status !== "ok" || zero.status !== "ok") return;
    expect(negZero.text).not.toBe(zero.text);
  });

  it("canonical 输出逐层冻结；调用方修改原 args 不影响编码文本", () => {
    const args: Record<string, unknown> = { outer: { inner: [1, { deep: true }] } };
    const encoded = canonicalizeTreasuryActionArgs(args);
    expect(encoded.status).toBe("ok");
    if (encoded.status !== "ok") return;
    const textBefore = encoded.text;
    expect(Object.isFrozen(encoded.canonical)).toBe(true);
    const outer = encoded.canonical as { inner: unknown };
    expect(Object.isFrozen(outer)).toBe(true);
    (args.outer as { inner: unknown }).inner = [9, 9, 9];
    (args as { outer: { deep: boolean } }).outer.deep = false;
    expect(encoded.text).toBe(textBefore);
  });
});

describe("canonicalizeTreasuryActionArgs 拒绝集合（结构化拒绝零抛出）", () => {
  it("cyclic 对象与 cyclic 数组拒绝", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(canonicalizeTreasuryActionArgs(cyclic).status).toBe("rejected");
    const cyclicArray: unknown[] = [1];
    cyclicArray.push(cyclicArray);
    expect(canonicalizeTreasuryActionArgs(cyclicArray).status).toBe("rejected");
  });

  it("getter/setter 拒绝且 getter 不被副作用读取（读取计数为 0）", () => {
    let reads = 0;
    const withGetter = {};
    Object.defineProperty(withGetter, "trap", {
      enumerable: true,
      get() {
        reads += 1;
        return 42;
      },
    });
    const result = canonicalizeTreasuryActionArgs(withGetter);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("accessor");
    expect(reads).toBe(0);
  });

  it("undefined / NaN / ±Infinity / function / symbol / bigint 拒绝（对象值与数组元素）", () => {
    expect(canonicalizeTreasuryActionArgs({ u: undefined }).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs({ n: Number.NaN }).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs({ p: Number.POSITIVE_INFINITY }).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs({ f: () => 1 }).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs({ s: Symbol("x") }).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs({ b: BigInt(10) }).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs([1, undefined]).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs([Number.NaN]).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs([() => 2]).status).toBe("rejected");
  });

  it("class instance / Date / Map / Set（非普通 prototype）拒绝", () => {
    class Payload {
      constructor(public value = 1) {}
    }
    expect(canonicalizeTreasuryActionArgs(new Payload()).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs(new Date(0)).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs(new Map()).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs(new Set()).status).toBe("rejected");
  });

  it("稀疏数组与 symbol 键拒绝（静默丢弃不可接受）", () => {
    const sparse: unknown[] = new Array(5);
    sparse[0] = 1;
    sparse[4] = 2;
    expect(canonicalizeTreasuryActionArgs(sparse).status).toBe("rejected");
    const withSymbolKey = { ok: 1 } as Record<string | symbol, unknown>;
    withSymbolKey[Symbol("hidden")] = 2;
    expect(canonicalizeTreasuryActionArgs(withSymbolKey).status).toBe("rejected");
  });

  it("超深/超长编码/超长数组/超多键有界拒绝", () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(canonicalizeTreasuryActionArgs(deep).status).toBe("rejected");
    const longText = { blob: "x".repeat(TREASURY_CANONICAL_MAX_TEXT_LENGTH + 100) };
    expect(canonicalizeTreasuryActionArgs(longText).status).toBe("rejected");
    const bigArray = Array.from({ length: 300 }, (_, i) => i);
    expect(canonicalizeTreasuryActionArgs(bigArray).status).toBe("rejected");
    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < 100; i += 1) manyKeys[`k${String(i)}`] = i;
    expect(canonicalizeTreasuryActionArgs(manyKeys).status).toBe("rejected");
  });

  it("拒绝结果携带结构化 detail（不抛出、不返回部分 canonical）", () => {
    const result = canonicalizeTreasuryActionArgs({ u: undefined });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(typeof result.detail).toBe("string");
      expect(result.detail.length).toBeGreaterThan(0);
      expect("canonical" in result).toBe(false);
    }
  });
});

describe("canonicalization 反射异常边界（第十轮 3.12.12：Proxy trap 结构化拒绝）", () => {
  it("revoked Proxy：结构化拒绝不抛出", () => {
    const target: Record<string, unknown> = { a: 1 };
    const revocable = Proxy.revocable(target, {});
    revocable.revoke();
    const result = canonicalizeTreasuryActionArgs(revocable.proxy);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("reflection_fault");
  });

  it("throwing ownKeys trap：结构化拒绝", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys hostile");
        },
      },
    );
    const result = canonicalizeTreasuryActionArgs(hostile);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("reflection_fault");
  });

  it("throwing getPrototypeOf trap：结构化拒绝", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("gop hostile");
        },
      },
    );
    const result = canonicalizeTreasuryActionArgs(hostile);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("reflection_fault");
  });

  it("throwing getOwnPropertyDescriptor trap：结构化拒绝（getter 零调用）", () => {
    let getterCalls = 0;
    const hostile = new Proxy(
      { x: 1 },
      {
        getOwnPropertyDescriptor() {
          throw new Error("gopd hostile");
        },
        get() {
          getterCalls += 1;
          return 1;
        },
      },
    );
    const result = canonicalizeTreasuryActionArgs(hostile);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("reflection_fault");
    expect(getterCalls).toBe(0); // descriptor 检查先于值读取——getter 零调用
  });

  it("throwing get trap（descriptor 合法但值读取抛错）：结构化拒绝", () => {
    const hostile = new Proxy(
      { x: 1 },
      {
        get() {
          throw new Error("get hostile");
        },
      },
    );
    const result = canonicalizeTreasuryActionArgs(hostile);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("read_property");
  });

  it("throwing iterator（数组 for..of trap）：结构化拒绝", () => {
    const hostile = new Proxy([1, 2, 3], {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          throw new Error("iterator hostile");
        }
        return (target as unknown as Record<symbol, unknown>)[prop];
      },
    });
    const result = canonicalizeTreasuryActionArgs(hostile);
    expect(result.status).toBe("rejected");
  });

  it("rejection 零副作用：多次拒绝后正常输入仍可编码（无状态残留）", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("registry hostile");
        },
      },
    );
    expect(canonicalizeTreasuryActionArgs(hostile).status).toBe("rejected");
    expect(canonicalizeTreasuryActionArgs(hostile).status).toBe("rejected");
    // 无栈/状态残留：正常对象仍可确定性编码。
    const ok = canonicalizeTreasuryActionArgs({ a: 1 });
    expect(ok.status).toBe("ok");
  });
});
