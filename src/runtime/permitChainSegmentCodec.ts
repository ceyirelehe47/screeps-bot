import { strFromU8, strToU8, unzlibSync, zlibSync } from "fflate";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";

export const PERMIT_CHAIN_STORAGE_KIND = "permit-chain-segments-v1" as const;
export const PERMIT_CHAIN_CHUNK_KIND = "permit-chain-chunk-v1" as const;
export const PERMIT_CHAIN_MAX_JSON_BYTES = 1_500_000;
export const PERMIT_CHAIN_CHUNK_LENGTH = 90_000;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const HASH = /^csh1:[0-9a-f]{32}$/;

export interface PermitChainManifest {
  kind: typeof PERMIT_CHAIN_STORAGE_KIND;
  epoch: number;
  segmentIds: number[];
  jsonBytes: number;
  jsonLength: number;
  jsonHash: string;
  payloadLength: number;
  payloadHash: string;
  manifestHash: string;
}

export interface EncodedPermitChain {
  manifest: PermitChainManifest;
  parts: string[];
  json: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPermitChainManifestCandidate(value: unknown): boolean {
  return record(value) && ("kind" in value && value.kind === PERMIT_CHAIN_STORAGE_KIND || "manifestHash" in value && "segmentIds" in value);
}

function manifestHash(value: Omit<PermitChainManifest, "manifestHash">): string {
  return canonicalStableHashV1({ domain: PERMIT_CHAIN_STORAGE_KIND, ...value });
}

export function validatePermitChainManifest(value: unknown): value is PermitChainManifest {
  if (!record(value) || Object.keys(value).sort().join(",") !==
    "epoch,jsonBytes,jsonHash,jsonLength,kind,manifestHash,payloadHash,payloadLength,segmentIds") return false;
  if (value.kind !== PERMIT_CHAIN_STORAGE_KIND || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1 ||
    !Array.isArray(value.segmentIds) || value.segmentIds.length < 1 || value.segmentIds.length > 4 ||
    Array.from(value.segmentIds).some(id => !Number.isInteger(id) || id < 0 || id > 99) ||
    new Set(value.segmentIds).size !== value.segmentIds.length ||
    !Number.isSafeInteger(value.jsonBytes) || (value.jsonBytes as number) < 2 || (value.jsonBytes as number) > PERMIT_CHAIN_MAX_JSON_BYTES ||
    !Number.isSafeInteger(value.jsonLength) || (value.jsonLength as number) < 2 || (value.jsonLength as number) > (value.jsonBytes as number) ||
    !Number.isSafeInteger(value.payloadLength) || (value.payloadLength as number) < 4 ||
    (value.payloadLength as number) > value.segmentIds.length * PERMIT_CHAIN_CHUNK_LENGTH ||
    Math.ceil((value.payloadLength as number) / PERMIT_CHAIN_CHUNK_LENGTH) !== value.segmentIds.length ||
    ![value.jsonHash, value.payloadHash, value.manifestHash].every(hash => typeof hash === "string" && HASH.test(hash))) return false;
  const { manifestHash: actual, ...payload } = value;
  return manifestHash(payload as unknown as Omit<PermitChainManifest, "manifestHash">) === actual;
}

function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index], second = bytes[index + 1], third = bytes[index + 2];
    const value = first << 16 | (second ?? 0) << 8 | (third ?? 0);
    parts.push(BASE64[value >>> 18 & 63], BASE64[value >>> 12 & 63],
      second === undefined ? "=" : BASE64[value >>> 6 & 63], third === undefined ? "=" : BASE64[value & 63]);
  }
  return parts.join("");
}

function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error("permit_chain_base64_invalid");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(text.length / 4 * 3 - padding);
  let bits = 0, count = 0, offset = 0;
  for (const character of text) {
    if (character === "=") break;
    bits = bits << 6 | BASE64.indexOf(character);
    count += 6;
    if (count >= 8) { count -= 8; bytes[offset++] = bits >>> count & 255; }
  }
  if (encodeBase64(bytes) !== text) throw new Error("permit_chain_base64_noncanonical");
  return bytes;
}

export function encodePermitChain(chain: unknown, epoch: number, bank: readonly number[]): EncodedPermitChain {
  if (!record(chain) || isPermitChainManifestCandidate(chain)) throw new Error("permit_chain_inline_required");
  if (!Number.isSafeInteger(epoch) || epoch < 1 || bank.length < 1 || bank.length > 4 ||
    new Set(bank).size !== bank.length || Array.from(bank).some(id => !Number.isInteger(id) || id < 0 || id > 99)) {
    throw new Error("permit_chain_bank_invalid");
  }
  const json = JSON.stringify(chain);
  const bytes = strToU8(json);
  if (bytes.length > PERMIT_CHAIN_MAX_JSON_BYTES) throw new Error("permit_chain_json_too_large");
  const payload = encodeBase64(zlibSync(bytes, { level: 6 }));
  const count = Math.ceil(payload.length / PERMIT_CHAIN_CHUNK_LENGTH);
  if (count > bank.length) throw new Error("permit_chain_bank_capacity");
  const base: Omit<PermitChainManifest, "manifestHash"> = {
    kind: PERMIT_CHAIN_STORAGE_KIND, epoch, segmentIds: bank.slice(0, count),
    jsonBytes: bytes.length, jsonLength: json.length,
    jsonHash: canonicalStableHashV1({ domain: "permit-chain-json-v1", json }),
    payloadLength: payload.length,
    payloadHash: canonicalStableHashV1({ domain: "permit-chain-payload-v1", payload }),
  };
  const manifest: PermitChainManifest = { ...base, manifestHash: manifestHash(base) };
  const parts = manifest.segmentIds.map((_id, index) => JSON.stringify({
    kind: PERMIT_CHAIN_CHUNK_KIND, manifestHash: manifest.manifestHash, epoch,
    index, count, data: payload.slice(index * PERMIT_CHAIN_CHUNK_LENGTH, (index + 1) * PERMIT_CHAIN_CHUNK_LENGTH),
  }));
  return { manifest, parts, json };
}

export function decodePermitChain(manifest: PermitChainManifest, parts: readonly string[]): {
  chain: Readonly<Record<string, unknown>>; json: string;
} {
  if (!validatePermitChainManifest(manifest) || parts.length !== manifest.segmentIds.length) throw new Error("permit_chain_manifest_invalid");
  const payload = parts.map((text, index) => {
    if (text.length > 102_400) throw new Error("permit_chain_segment_too_large");
    const part: unknown = JSON.parse(text);
    if (!record(part) || part.kind !== PERMIT_CHAIN_CHUNK_KIND || part.manifestHash !== manifest.manifestHash ||
      part.epoch !== manifest.epoch || part.index !== index || part.count !== parts.length ||
      typeof part.data !== "string" || part.data.length > PERMIT_CHAIN_CHUNK_LENGTH) throw new Error("permit_chain_part_invalid");
    return part.data;
  }).join("");
  if (payload.length !== manifest.payloadLength ||
    canonicalStableHashV1({ domain: "permit-chain-payload-v1", payload }) !== manifest.payloadHash) throw new Error("permit_chain_payload_mismatch");
  const compressed = decodeBase64(payload);
  const bytes = unzlibSync(compressed, { out: new Uint8Array(manifest.jsonBytes) });
  if (bytes.length !== manifest.jsonBytes) throw new Error("permit_chain_json_length");
  // fflate 的固定输出缓冲限制解压分配；同时验证 zlib 尾部 Adler32，
  // 防止输出被缓冲截断后恰好留下可解析 JSON 而被误认为完整 payload。
  let a = 1, b = 0;
  for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  const offset = compressed.length - 4;
  const expectedAdler = (compressed[offset] << 24 | compressed[offset + 1] << 16 | compressed[offset + 2] << 8 | compressed[offset + 3]) >>> 0;
  if (((b << 16 | a) >>> 0) !== expectedAdler) throw new Error("permit_chain_zlib_checksum");
  const json = strFromU8(bytes);
  if (json.length !== manifest.jsonLength || canonicalStableHashV1({ domain: "permit-chain-json-v1", json }) !== manifest.jsonHash) {
    throw new Error("permit_chain_json_mismatch");
  }
  const chain: unknown = JSON.parse(json);
  if (!record(chain) || isPermitChainManifestCandidate(chain)) throw new Error("permit_chain_payload_shape");
  function freeze(value: unknown): void {
    if (value && typeof value === "object") {
      for (const nested of Object.values(value)) freeze(nested);
      Object.freeze(value);
    }
  }
  freeze(chain);
  return { chain, json };
}
