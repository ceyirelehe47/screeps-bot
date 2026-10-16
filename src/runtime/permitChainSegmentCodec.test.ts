import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";
import {
  decodePermitChain, encodePermitChain, validatePermitChainManifest,
} from "@/runtime/permitChainSegmentCodec";

describe("许可链分段编码", () => {
  it("Unicode、转义和多段数据精确往返，展开后深冻结", () => {
    let seed = 123456789;
    const noise = Array.from({ length: 130000 }, () => {
      seed = Math.imul(seed, 1664525) + 1013904223 | 0;
      return String.fromCharCode(33 + (seed >>> 8) % 90);
    }).join("");
    const chain = { revision: 1, text: "许可😀\n\"\\", nested: [{ noise }] };
    const encoded = encodePermitChain(chain, 3, [81, 82, 83]);
    expect(encoded.parts.length).toBeGreaterThan(1);
    expect(encoded.parts.every(part => part.length <= 102400)).toBe(true);
    expect(validatePermitChainManifest(encoded.manifest)).toBe(true);
    const decoded = decodePermitChain(encoded.manifest, encoded.parts);
    expect(decoded.json).toBe(JSON.stringify(chain));
    expect(decoded.chain).toEqual(chain);
    expect(Object.isFrozen(decoded.chain)).toBe(true);
    expect(Object.isFrozen((decoded.chain.nested as object[])[0])).toBe(true);
  });

  it("拒绝坏 manifest、错误代次、错位片、截断、超量与非密集 bank", () => {
    const encoded = encodePermitChain({ entries: [{ id: "原链" }] }, 1, [81]);
    for (const manifest of [
      { ...encoded.manifest, epoch: 2 }, { ...encoded.manifest, segmentIds: [81, 81] },
      { ...encoded.manifest, jsonBytes: 2000000 }, { ...encoded.manifest, extra: true },
    ]) expect(validatePermitChainManifest(manifest)).toBe(false);
    const part = JSON.parse(encoded.parts[0]);
    for (const text of ["", encoded.parts[0].slice(1), JSON.stringify({ ...part, epoch: 2 }),
      JSON.stringify({ ...part, data: part.data.slice(4) }), "x".repeat(102401)]) {
      expect(() => decodePermitChain(encoded.manifest, [text])).toThrow();
    }
    expect(() => encodePermitChain({}, 1, new Array(1))).toThrow("bank_invalid");
    expect(() => encodePermitChain({}, 1, [81, 81])).toThrow("bank_invalid");
    expect(() => encodePermitChain({ text: "x".repeat(1500001) }, 1, [81])).toThrow("json_too_large");
  });

  it("存储摘要不能代替原许可链摘要和业务授权", () => {
    const chain = { fabricated: true, entries: [{ arbitrary: "这不是授权" }] };
    const encoded = encodePermitChain(chain, 1, [81]);
    const decoded = decodePermitChain(encoded.manifest, encoded.parts);
    expect(canonicalStableHashV1(decoded.chain)).toBe(canonicalStableHashV1(chain));
    expect(decoded.chain).toEqual(chain);
    expect(encoded.manifest.jsonHash).not.toBe(canonicalStableHashV1(chain));
  });
});
