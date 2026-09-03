/**
 * 【Round 22 Remediation V 七】cleanup journal entry 的 exact attempt
 * identity 构造（单一口径——pre-release gate 与 lineage finalization proof
 * 共享；独立模块避免 gate ↔ finalizationProof 的模块环）。
 */

import { treasuryExactAttemptIdentityOfFacts, type TreasuryExactAttemptIdentity } from "@/runtime/treasury/exactAttemptIdentity";
import type { TreasuryResolutionCleanupEntry } from "@/runtime/treasury/resolutionCleanupJournal";

/** journal entry（含 identity 形状）→ exact attempt identity（单一构造口径）。 */
export function treasuryPreReleaseExactIdentityOfEntry(
  entry: Readonly<TreasuryResolutionCleanupEntry>,
): TreasuryExactAttemptIdentity | null {
  return treasuryExactAttemptIdentityOfFacts(
    entry.transactionId,
    {
      digest: entry.digest,
      ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
      ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
      ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
      ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
      ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
      ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
      ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
      ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
    },
    entry.proofClass === "lowlevel" ? "lowlevel" : entry.proofClass === "identity-bound" ? "identity-bound" : "legacy",
  );
}
