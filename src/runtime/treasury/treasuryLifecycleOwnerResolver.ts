/**
 * 【Round 22 Remediation IX 工作流 E 8.3】统一 lifecycle owner resolver——
 * orphan / GC 判定的唯一 owner 真相源。
 *
 * 修复前的 orphan 判定各自手工拼部分 store 列表（retired range 的孤儿 gap
 * coalesce 只查 7 类；reservation TTL sweep 只查 9 类）——"不在部分 store
 * 中"被解释成 orphan。本模块按完整生命周期权威判定：
 *
 * active/unresolved owner（kind="active"——阻断 orphan sweep 与 sequence
 * abandon）：
 *  - production issued ticket（active）；
 *  - receipt admission reservation（heap——prepare→commit 窗口）；
 *  - completion headroom reservation；
 *  - durable Intent / Quarantine / cleanup journal / resolving Resolution；
 *  - Authorization Fault / write-fault marker；
 *  - 活跃（非 terminal）attempt lineage；
 *  - matching live completion（pair——identity 冲突的 pair 不被 sweep 绕过）。
 *
 * terminal 权威（kind="terminal-authority"——阻断 sequence abandon（O4），
 * 不阻断 reservation orphan sweep（cleanup 已终结的 reservation 应释放））：
 *  - final Resolution tombstone / terminal lineage；
 *  - settled Receipt / live completion / historical completion；
 *  - generation retirement proof / retirement summary。
 *
 * fail closed：任一相关 store unhealthy → owned（不把"读不到"解释成
 * orphan）；probe 未装配 → owned。certificate / retired range 维度由调用方
 * （chainRetirementCertificate——同模块自查）补充。
 *
 * 【Round 22 Remediation X 工作流 E / H1-H10】health-complete：
 *  - Intent / Quarantine 的 fatal 与 absent 在 read API 同形（undefined）——
 *    判定前先 ensure 触发 load 全量校验（entry 级损坏含 unrelated entry
 *    同样检出 → owned+unhealthy，H1/H2）；
 *  - settled receipt 的整店 heap fatal（他键损坏/迁移失败）同样
 *    owned+unhealthy（H 系）；
 *  - retirement summary probe 未装配 → owned+unhealthy（与其余 probe 一致，
 *    不再静默跳过维度）。
 *
 * 【Round 22 Remediation XI 工作流 A】verdict 字段把"owned"的双语义结构化
 * 拆开：exact_owner（确有正向 durable owner——唯一可授权 ticket handoff
 * consume 的 verdict）与 blocked（store unhealthy / probe 未装配 / identity
 * conflict 等保守阻断——GC/orphan 判定按 owned 处理，但绝不构成正向 owner）。
 * ticket handoff 协议只消费 exact_owner；调用方不得用 owner 描述字符串或
 * !storeUnhealthy 判断安全语义（H5：conflict 是 storeUnhealthy=false 的
 * blocked）。
 */

import { readTreasuryIssuedAttemptTicket, peekTreasuryIssuedAttemptTicketHealth } from "@/runtime/treasury/attemptIssuanceTicket";
import { hasTreasuryReceiptAdmissionReservation, lookupTreasurySettledReceipt, peekTreasuryReceiptHealth } from "@/runtime/treasury/receipts";
import {
  peekTreasuryCompletionHeadroomReservation,
  peekTreasuryCompletionHeadroomReservationHealth,
} from "@/runtime/treasury/completionHeadroomReservation";
import { peekTreasuryIntentStoreValidation, readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { ensureTreasuryQuarantineStoreValidated, readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  peekTreasuryResolutionCleanupHealth,
  readTreasuryResolutionCleanupEntry,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  peekTreasuryAuthorizationFaultHealth,
  readTreasuryAuthorizationFaultEntry,
} from "@/runtime/treasury/authorizationFaults";
import { peekTreasuryWriteFaultHealth, readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { lookupTreasuryCleanupCompletion } from "@/runtime/treasury/cleanupCompletionAuthority";
import { lookupTreasuryHistoricalCompletion } from "@/runtime/treasury/cleanupSupersessionAuthority";

export type TreasuryLifecycleOwnershipKind = "active" | "terminal-authority";

/**
 * 【Round 22 Remediation XI 工作流 A】正向证明与保守阻断的结构化区分。
 * "现在不能删除/不能执行"（blocked——GC blocker）不等于"新的 owner 已经
 * 接管"（exact_owner）。ticket handoff 只允许消费 exact_owner；blocked
 * 一律拒绝且保持 ticket 原状态（H1-H5）。
 */
export type TreasuryLifecycleOwnershipVerdict =
  /** 确有正向、结构化、来源明确的 durable owner（该维度 entry 真实在位）。 */
  | "exact_owner"
  /**
   * 保守阻断（store unhealthy / probe 未装配 / identity conflict / 语义
   * 不可判定）——防止 GC 而阻断，绝不构成正向 owner 或 handoff 依据。
   */
  | "blocked"
  /** 全部权威维度确证为空（每个维度都健康且明确 absent）。 */
  | "absent";

export interface TreasuryLifecycleOwnershipResolution {
  /** owned = 存在任一 owner（或 fail closed）；unowned = 全部权威确证为空。 */
  readonly status: "owned" | "unowned";
  /** owner 类别（unowned 时为 null）。 */
  readonly kind: TreasuryLifecycleOwnershipKind | null;
  /** owner 描述（诊断/测试）。 */
  readonly owner: string | null;
  /** 任一相关 store unhealthy（此时恒 owned——fail closed）。 */
  readonly storeUnhealthy: boolean;
  /** 【XI 工作流 A】结构化 verdict（不得靠 owner 描述字符串判断安全语义）。 */
  readonly verdict: TreasuryLifecycleOwnershipVerdict;
}

// 【模块环规避】resolutionStore / attemptLineage / lineageRetirementSummary
// 在本 resolver 的加载上游或互相成环（resolver 被 chainRetirementCertificate
// 与 cleanupCompletionHandoff 顶层 import）。probe 注册方在各模块文件底部
// （延迟 import + 立即注册——与既有 register 模式同构）。未装配 → owned。
interface TreasuryLifecycleTombstoneProbe {
  readonly tombstoneOf: (transactionId: string) => { readonly stage?: unknown } | undefined;
  readonly tombstoneStoreHealthy: () => boolean;
}

interface TreasuryLifecycleLineageProbe {
  readonly lineageOf: (transactionId: string) => { readonly state?: unknown } | undefined;
  readonly lineageStoreHealthy: () => boolean;
}

interface TreasuryLifecycleSummaryProbe {
  readonly summaryOfRoot: (rootTransactionId: string) => { readonly lineageId?: unknown } | undefined;
  readonly summaryStoreHealthy: () => boolean;
}

// 【模块环规避】GRA import resolutionStore（proof release 注册），而
// resolutionStore 底部注册本 resolver 的 tombstone probe——GRA 维度同样经
// probe 注入（注册方：generationRetirementAuthority 模块底部）。
interface TreasuryLifecycleGenerationProofProbe {
  readonly proofOfAttempt: (transactionId: string) => unknown;
  readonly proofStoreHealthy: () => boolean;
}

let tombstoneProbe: TreasuryLifecycleTombstoneProbe | null = null;
let lineageProbe: TreasuryLifecycleLineageProbe | null = null;
let summaryProbe: TreasuryLifecycleSummaryProbe | null = null;
let generationProofProbe: TreasuryLifecycleGenerationProofProbe | null = null;

export function registerTreasuryLifecycleTombstoneProbeForAssembly(probe: TreasuryLifecycleTombstoneProbe): void {
  tombstoneProbe = probe;
}

export function registerTreasuryLifecycleLineageProbeForAssembly(probe: TreasuryLifecycleLineageProbe): void {
  lineageProbe = probe;
}

export function registerTreasuryLifecycleSummaryProbeForAssembly(probe: TreasuryLifecycleSummaryProbe): void {
  summaryProbe = probe;
}

export function registerTreasuryLifecycleGenerationProofProbeForAssembly(probe: TreasuryLifecycleGenerationProofProbe): void {
  generationProofProbe = probe;
}

/**
 * 完整生命周期权威判定（O1-O6）。返回 never-owned 之外的任何 owner 事实；
 * store unhealthy 一律 owned（fail closed）。
 *
 * options.excludeIssuedTicket：跳过 issued ticket 维度（X 工作流 B 的
 * handoff 协议用它判定"durable owner 在位"——ticket 是被接管对象，不是
 * 它自己的 durable owner；不排除则 active ticket 恒 owned，consume 永远
 * 无法满足 owner 前置）。
 *
 * options.excludeInflightReservations：跳过 receipt admission reservation
 * （heap）与 completion headroom reservation 两个 prepare→commit 窗口的
 * 瞬态预留维度（X 工作流 B 的 ticket gate 用——heap 预留不是 durable
 * Memory 事实，global reset 后消失，不承载"execution-started 已持久化"
 * 语义；本次 prepare 自己的预留不得被解读为接管已完成的恢复场景）。
 */
export function resolveTreasuryAttemptLifecycleOwnership(
  transactionId: string,
  options?: {
    readonly excludeHeadroomReservation?: boolean;
    readonly excludeIssuedTicket?: boolean;
    readonly excludeInflightReservations?: boolean;
  },
): TreasuryLifecycleOwnershipResolution {
  const owned = (kind: TreasuryLifecycleOwnershipKind, owner: string): TreasuryLifecycleOwnershipResolution => ({
    status: "owned",
    kind,
    owner,
    storeUnhealthy: false,
    verdict: "exact_owner",
  });
  const unhealthyOwned = (owner: string): TreasuryLifecycleOwnershipResolution => ({
    status: "owned",
    kind: "active",
    owner,
    storeUnhealthy: true,
    verdict: "blocked",
  });
  // 【XI 工作流 A / H5】identity conflict 等结构化 blocker：阻断 GC/orphan
  // 判定，但不是正向 owner（storeUnhealthy=false 的 blocked——不能用
  // !storeUnhealthy 区分，必须读 verdict）。
  const blockerOwned = (owner: string): TreasuryLifecycleOwnershipResolution => ({
    status: "owned",
    kind: "active",
    owner,
    storeUnhealthy: false,
    verdict: "blocked",
  });

  // 1) production issued ticket（active——opening 前的 lifecycle owner）。
  //    【X 工作流 B】handoff 协议经 excludeIssuedTicket 排除自身维度。
  const ticketHealth = peekTreasuryIssuedAttemptTicketHealth();
  if (!ticketHealth.healthy) return unhealthyOwned(`issued ticket store unhealthy（fail closed）: ${ticketHealth.detail}`);
  if (options?.excludeIssuedTicket !== true) {
    const ticket = readTreasuryIssuedAttemptTicket(transactionId);
    if (ticket !== undefined && ticket.state === "active") return owned("active", "active issued ticket（受控 opening 在飞）");
  }

  // 2) receipt admission reservation（heap——prepare→commit 窗口）。
  //    【X 工作流 B】ticket gate 的恢复判定排除（瞬态 heap 预留不是 durable
  //    Memory 事实）；orphan sweep 等生命周期判定保留（在飞即有 owner）。
  if (options?.excludeInflightReservations !== true) {
    if (hasTreasuryReceiptAdmissionReservation(transactionId)) return owned("active", "receipt admission reservation（prepare→commit 窗口）");
  }

  // 3) completion headroom reservation（reservation TTL sweep 自身对象的
  //    维度经 excludeHeadroomReservation 排除——否则 sweep 永远自引用
  //    owned；sequence abandon 场景不排除：headroom reservation 在位 =
  //    该 sequence 有 active owner（O1）；ticket gate 经
  //    excludeInflightReservations 一并排除——瞬态预留不构成接管完成）。
  const reservationHealth = peekTreasuryCompletionHeadroomReservationHealth();
  if (!reservationHealth.healthy) return unhealthyOwned(`headroom reservation store unhealthy（fail closed）: ${reservationHealth.detail}`);
  if (options?.excludeHeadroomReservation !== true && options?.excludeInflightReservations !== true) {
    if (peekTreasuryCompletionHeadroomReservation(transactionId) !== undefined) {
      return owned("active", "completion headroom reservation");
    }
  }

  // 4) durable Intent。【X 工作流 E / H1/H2】fatal 时 read 返回 undefined 与
  //    absent 同形——全量校验（unrelated entry 损坏同样检出为 fatal），
  //    fatal → owned+unhealthy（不折叠为 absent）。【XI 工作流 E / M1】
  //    校验零写（peek——store 不存在 = 健康空，不创建；迁移只在写路径
  //    load 发生，query 不迁移）。
  const intentValidationError = peekTreasuryIntentStoreValidation();
  if (intentValidationError !== null) return unhealthyOwned(`intent store unhealthy（fail closed）: ${intentValidationError}`);
  if (readTreasuryIntentEntry(transactionId) !== undefined) return owned("active", "durable intent");

  // 5) Quarantine。【X 工作流 E / H3】同 Intent——ensure 触发全量校验。
  const quarantineValidationError = ensureTreasuryQuarantineStoreValidated();
  if (quarantineValidationError !== null) return unhealthyOwned(`quarantine store unhealthy（fail closed）: ${quarantineValidationError}`);
  if (readTreasuryQuarantineEntry(transactionId) !== undefined) return owned("active", "durable quarantine");

  // 6) cleanup journal。
  const journalHealth = peekTreasuryResolutionCleanupHealth();
  if (!journalHealth.healthy) return unhealthyOwned(`cleanup journal store unhealthy（fail closed）: ${journalHealth.detail ?? ""}`);
  if (readTreasuryResolutionCleanupEntry(transactionId) !== undefined) return owned("active", "cleanup journal");

  // 7) Authorization Fault。
  const faultHealth = peekTreasuryAuthorizationFaultHealth();
  if (!faultHealth.healthy) return unhealthyOwned(`authorization fault store unhealthy（fail closed）: ${faultHealth.detail ?? ""}`);
  if (readTreasuryAuthorizationFaultEntry(transactionId) !== undefined) return owned("active", "authorization fault");

  // 8) write-fault marker。
  const markerHealth = peekTreasuryWriteFaultHealth();
  if (!markerHealth.healthy) return unhealthyOwned(`write-fault marker store unhealthy（fail closed）: ${markerHealth.detail ?? ""}`);
  const marker = readTreasuryWriteFault();
  if (marker !== undefined && marker.transactionId === transactionId) return owned("active", "write-fault marker");

  // 9) Resolution tombstone（resolving = active；final = terminal 权威）。
  if (tombstoneProbe === null) return unhealthyOwned("resolution owner probe 未装配（fail closed——视为 owned）");
  if (!tombstoneProbe.tombstoneStoreHealthy()) return unhealthyOwned("resolution store unhealthy（fail closed）");
  const tombstone = tombstoneProbe.tombstoneOf(transactionId);
  if (tombstone !== undefined && tombstone.stage !== "final") {
    return owned("active", `resolving resolution（stage=${String(tombstone.stage)}）`);
  }

  // 10) attempt lineage（非 terminal = active；terminal = terminal 权威）。
  if (lineageProbe === null) return unhealthyOwned("attempt lineage probe 未装配（fail closed——视为 owned）");
  if (!lineageProbe.lineageStoreHealthy()) return unhealthyOwned("attempt lineage store unhealthy（fail closed）");
  const lineage = lineageProbe.lineageOf(transactionId);
  if (lineage !== undefined && lineage.state !== "chain_committed" && lineage.state !== "non_rearmable_retired" && lineage.state !== "forensic_isolated") {
    return owned("active", `active lineage（state=${String(lineage.state)}）`);
  }

  // 11) matching live completion（pair——identity 冲突保护；对 sequence
  //     abandon 同样是权威）。
  const completion = lookupTreasuryCleanupCompletion(transactionId);
  if (completion.verdict === "store_unhealthy") return unhealthyOwned(`live completion store unhealthy（fail closed）: ${completion.detail}`);
  if (completion.verdict === "conflict") return blockerOwned("live completion 权威冲突（结构化冲突——GC blocker，非正向 owner）");
  if (completion.verdict === "match") return owned("active", "matching live completion（pair）");

  // 12) historical completion / settled receipt / GRA / final tombstone /
  //     terminal lineage / retirement summary——terminal 权威（阻断 sequence
  //     abandon，不阻断 reservation orphan sweep）。
  const historical = lookupTreasuryHistoricalCompletion(transactionId);
  if (historical.verdict === "store_unhealthy") return unhealthyOwned(`historical completion store unhealthy（fail closed）: ${historical.detail}`);
  if (historical.verdict !== "absent") return owned("terminal-authority", "historical completion（durable archive）");

  // 【X 工作流 E】settled receipt 的整店 heap fatal（他键损坏 / 迁移失败，
  // own key 缺失时 lookup 返回 absent）同样 fail closed——health 前置。
  const receiptHealth = peekTreasuryReceiptHealth();
  if (!receiptHealth.healthy) return unhealthyOwned(`settled receipt store unhealthy（fail closed）: ${receiptHealth.detail}`);
  const receipt = lookupTreasurySettledReceipt(transactionId);
  if (receipt.status === "corrupted") return unhealthyOwned("settled receipt store unhealthy（fail closed）");
  if (receipt.status !== "absent") return owned("terminal-authority", "settled receipt");

  if (generationProofProbe === null) return unhealthyOwned("generation retirement probe 未装配（fail closed——视为 owned）");
  if (!generationProofProbe.proofStoreHealthy()) return unhealthyOwned("generation retirement store unhealthy（fail closed）");
  if (generationProofProbe.proofOfAttempt(transactionId) !== undefined) {
    return owned("terminal-authority", "generation retirement proof");
  }

  if (tombstone !== undefined && tombstone.stage === "final") {
    return owned("terminal-authority", "final resolution tombstone");
  }
  if (lineage !== undefined) {
    return owned("terminal-authority", `terminal lineage（state=${String(lineage.state)}）`);
  }
  // 【X 工作流 E / H5】summary probe 未装配 → owned+unhealthy（与 tombstone/
  // lineage/GRA probe 一致——维度缺失不得折叠为 unowned）。
  if (summaryProbe === null) return unhealthyOwned("retirement summary probe 未装配（fail closed——视为 owned）");
  if (!summaryProbe.summaryStoreHealthy()) return unhealthyOwned("retirement summary store unhealthy（fail closed）");
  if (summaryProbe.summaryOfRoot(transactionId) !== undefined) {
    return owned("terminal-authority", "retirement summary");
  }
  return { status: "unowned", kind: null, owner: null, storeUnhealthy: false, verdict: "absent" };
}
