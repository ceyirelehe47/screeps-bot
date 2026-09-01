/**
 * 【第十七轮第九节】retry semantic identity——child 必须是 parent 动作的
 * 语义重试，而不是只使用不同 transaction ID 的任意新动作。
 *
 * 固定语义：
 * - 稳定、确定性、版本化的 digest（双 lane FNV-1a 16hex，纯函数零随机）；
 * - **modern contract 版**绑定实际 Game 动作语义：action kind、adapter
 *   version/registration/稳定语义身份、canonical action args 业务语义、
 *   canonical postings（资源/数量/room/location）、structure descriptors
 *   与角色、durable reconciliation payload/version、source、owner identity；
 * - **排除** parent/child transaction ID、tick、observation epoch、当前
 *   commitment/projection revision、policy decision digest、authorization
 *   bundle ID——child 必须重新经过当前状态授权（policy/commitment/库存/
 *   容量全部重估），但实际 Game 动作语义必须与 parent 一致；
 * - **lowlevel 版**绑定 kind、source、canonical postings、受控
 *   lowlevelSource、durable payload——facts 不足（缺受控 source 或缺
 *   postings/durable 语义）返回 null（non-rearmable，不签发 capability）。
 */

import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";
import type { TreasuryStructureBindingDescriptor } from "@/runtime/treasury/types";

export const TREASURY_RETRY_SEMANTIC_PROTOCOL = "treasury-retry-semantic@v1";

function descriptorSemanticText(descriptor: TreasuryStructureBindingDescriptor): string {
  const objectId = descriptor.objectId ?? "-";
  const expectedType = descriptor.expectedType ?? "-";
  const expectedRoom = descriptor.expectedRoom ?? "-";
  return `${descriptor.bindingKind}:${descriptor.role}:${descriptor.roomName}:${descriptor.locationKind}:${objectId}:${expectedType}:${expectedRoom}:${descriptor.required ? "1" : "0"}:${descriptor.structureId}`;
}

function postingSemanticText(leg: { roomName: string; locationKind: string; resource: string; delta: number }): string {
  return `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}\u0000${String(leg.delta)}`;
}

/** modern contract 的 retry 语义事实（contract / intent facts 的共同视图）。 */
export interface TreasuryModernRetrySemanticFacts {
  readonly actionKind: string;
  readonly adapterVersion?: number;
  readonly adapterRegistrationId?: string;
  readonly adapterSemanticIdentity?: string;
  /**
   * canonical action args 的业务语义文本——**不参与 digest**：durable
   * payload（durableFacts.payload，由 args 派生）已覆盖 args 业务语义且
   * intent/quarantine 均持久化（canonicalArgsText 仅 heap contract 携带，
   * parent facts 不可重建）。
   */
  readonly canonicalArgsText?: string;
  readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly structureDescriptors?: readonly TreasuryStructureBindingDescriptor[];
  readonly durablePayload?: string;
  readonly durablePayloadVersion?: number;
  readonly source: string;
  readonly ownerIdentity?: string;
}

/** lowlevel attempt 的 retry 语义事实。 */
export interface TreasuryLowlevelRetrySemanticFacts {
  readonly kind: string;
  readonly source: string;
  readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly lowlevelSource: string;
  /** durable payload（低层路径通常缺失——postings+kind+source 为核心语义）。 */
  readonly durablePayload?: string;
  readonly durablePayloadVersion?: number;
  readonly adapterSemanticIdentity?: string;
}

function encodePostings(postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[]): string {
  return postings
    .map(postingSemanticText)
    .sort()
    .map((text) => `${String(text.length)}:${text}`)
    .join(",");
}

/**
 * 计算 modern contract 的 retry semantic digest（与单个有界 contract 线性）。
 * 排除事实（transactionId/tick/epoch/revision/policy/bundle）不进入编码——
 * 相同 Game 动作语义、不同 child ID / tick / policy revision 的 digest 一致。
 */
export function computeTreasuryModernRetrySemanticDigest(facts: TreasuryModernRetrySemanticFacts): string {
  const parts: string[] = [
    `k:${String(facts.actionKind.length)}:${facts.actionKind}`,
    `av:${facts.adapterVersion === undefined ? "-" : String(facts.adapterVersion)}`,
    `ar:${facts.adapterRegistrationId === undefined ? "-" : facts.adapterRegistrationId}`,
    `asi:${facts.adapterSemanticIdentity === undefined ? "-" : `${String(facts.adapterSemanticIdentity.length)}:${facts.adapterSemanticIdentity}`}`,
    `p:${encodePostings(facts.postings)}`,
    `sd:${facts.structureDescriptors === undefined ? "-" : facts.structureDescriptors.map(descriptorSemanticText).sort().map((text) => `${String(text.length)}:${text}`).join(",")}`,
    `dp:${facts.durablePayload === undefined ? "-" : `${String(facts.durablePayloadVersion ?? 0)}:${facts.durablePayload}`}`,
    `s:${String(facts.source.length)}:${facts.source}`,
    `o:${facts.ownerIdentity === undefined ? "-" : `${String(facts.ownerIdentity.length)}:${facts.ownerIdentity}`}`,
  ];
  return hashTreasuryCanonicalString(`${TREASURY_RETRY_SEMANTIC_PROTOCOL}:modern:${parts.join("|")}`);
}

/**
 * 计算 lowlevel 的 retry semantic digest：facts 不足（缺 postings/受控
 * source/kind）返回 null——non-rearmable，不签发 capability。durable
 * identity digest **不参与**（它是 transaction ID 绑定的 attempt 身份，
 * 不是跨 attempt 的动作语义——child 的 durableIdentity 必然不同）。
 */
export function computeTreasuryLowlevelRetrySemanticDigest(facts: TreasuryLowlevelRetrySemanticFacts): string | null {
  if (!Array.isArray(facts.postings) || facts.postings.length === 0) return null;
  if (typeof facts.lowlevelSource !== "string" || facts.lowlevelSource.length === 0) return null;
  try {
    const parts: string[] = [
      `k:${String(facts.kind.length)}:${facts.kind}`,
      `s:${String(facts.source.length)}:${facts.source}`,
      `p:${encodePostings(facts.postings)}`,
      `lls:${String(facts.lowlevelSource.length)}:${facts.lowlevelSource}`,
      `dp:${facts.durablePayload === undefined ? "-" : `${String(facts.durablePayloadVersion ?? 0)}:${facts.durablePayload}`}`,
      `asi:${facts.adapterSemanticIdentity === undefined ? "-" : `${String(facts.adapterSemanticIdentity.length)}:${facts.adapterSemanticIdentity}`}`,
    ];
    return hashTreasuryCanonicalString(`${TREASURY_RETRY_SEMANTIC_PROTOCOL}:lowlevel:${parts.join("|")}`);
  } catch {
    return null;
  }
}

/**
 * 从 intent/quarantine entry 的持久事实提取 modern retry 语义（resolution
 * 路径为 parent 计算 retrySemanticDigest 用）。facts 不足返回 null。
 */
export function modernRetrySemanticFactsOfEntry(entry: {
  readonly actionKind?: string;
  readonly kind?: string;
  readonly adapterVersion?: number;
  readonly adapterRegistrationId?: string;
  readonly adapterSemanticIdentity?: string;
  readonly postings?:
    | readonly { roomName: string; locationKind: string; resource: string; delta: number }[]
    | readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly deltas?: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly structureFacts?: readonly (TreasuryStructureBindingDescriptor | { readonly [key: string]: unknown })[];
  readonly durablePayload?: string;
  readonly durablePayloadVersion?: number;
  readonly source?: string;
  readonly ownerIdentity?: string;
}): TreasuryModernRetrySemanticFacts | null {
  const postings = entry.postings ?? entry.deltas;
  const actionKind = entry.actionKind ?? entry.kind;
  if (postings === undefined || actionKind === undefined || entry.source === undefined) return null;
  if (entry.structureFacts !== undefined) {
    for (const descriptor of entry.structureFacts) {
      if (!descriptor || typeof descriptor !== "object") return null;
      const candidate = descriptor as Partial<TreasuryStructureBindingDescriptor>;
      if (
        typeof candidate.bindingKind !== "string" ||
        typeof candidate.role !== "string" ||
        typeof candidate.roomName !== "string" ||
        typeof candidate.locationKind !== "string"
      ) {
        return null;
      }
    }
  }
  return {
    actionKind,
    ...(entry.adapterVersion !== undefined ? { adapterVersion: entry.adapterVersion } : {}),
    ...(entry.adapterRegistrationId !== undefined ? { adapterRegistrationId: entry.adapterRegistrationId } : {}),
    ...(entry.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: entry.adapterSemanticIdentity } : {}),
    postings,
    ...(entry.structureFacts !== undefined
      ? { structureDescriptors: entry.structureFacts as readonly TreasuryStructureBindingDescriptor[] }
      : {}),
    ...(entry.durablePayload !== undefined ? { durablePayload: entry.durablePayload } : {}),
    ...(entry.durablePayloadVersion !== undefined ? { durablePayloadVersion: entry.durablePayloadVersion } : {}),
    source: entry.source,
    ...(entry.ownerIdentity !== undefined ? { ownerIdentity: entry.ownerIdentity } : {}),
  };
}

/**
 * 从 intent/quarantine entry 提取 lowlevel retry 语义。facts 不足（缺
 * postings/受控 source/kind）返回 null。
 */
export function lowlevelRetrySemanticFactsOfEntry(entry: {
  readonly kind?: string;
  readonly source?: string;
  readonly postings?:
    | readonly { roomName: string; locationKind: string; resource: string; delta: number }[]
    | readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly deltas?: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly lowlevelSource?: string;
  readonly durablePayload?: string;
  readonly durablePayloadVersion?: number;
  readonly adapterSemanticIdentity?: string;
}): TreasuryLowlevelRetrySemanticFacts | null {
  const postings = entry.postings ?? entry.deltas;
  if (postings === undefined || entry.kind === undefined || entry.source === undefined) return null;
  if (entry.lowlevelSource === undefined) return null;
  return {
    kind: entry.kind,
    source: entry.source,
    postings,
    lowlevelSource: entry.lowlevelSource,
    ...(entry.durablePayload !== undefined ? { durablePayload: entry.durablePayload } : {}),
    ...(entry.durablePayloadVersion !== undefined ? { durablePayloadVersion: entry.durablePayloadVersion } : {}),
    ...(entry.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: entry.adapterSemanticIdentity } : {}),
  };
}
