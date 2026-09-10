/** Isolated live experiment assembly. Uses the actual frozen production facade,
 * canonical action registry and policy registry, NEVER test/mock substitutes. */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { buildTreasuryActionContract, registerTreasuryActionAdapter, type TreasuryActionAdapter } from "@/runtime/treasury/actionContracts";
import { registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { bumpTreasuryWorldSequence } from "@/runtime/treasury/observation";
import type { LabExperimentConfig } from "../terminal-transfer/labConfig";
import { makeLiveTransferAdapter, LIVE_TRANSFER_KIND, SOURCE_ROOM, TARGET_ROOM } from "./adapter";
import { createLiveCoordinator } from "./coordinator";

export function assembleTreasuryIntegration(c: LabExperimentConfig) {
  const registration = registerTreasuryActionAdapter(makeLiveTransferAdapter(c) as TreasuryActionAdapter);
  if (registration.status !== "registered") throw new Error("live adapter registration refused: " + registration.detail);
  const policy = registerTreasuryPolicyResolver({
    policyId: "lab.terminal-only", policyVersion: 1,
    evaluate(context) {
      if (context.actionKind !== LIVE_TRANSFER_KIND || !["H", "energy"].includes(context.resource)
          || context.rooms.some(r => r !== SOURCE_ROOM && r !== TARGET_ROOM)) return { status: "rejected", reason: "outside isolated terminal policy" };
      // Explicit no-strategic-reserve policy for this synthetic fixture ONLY.
      // Existing task/reservation/kernel occupancy is still deducted by facade.
      return { withhold: 0, strategicReserve: 0, emergencyOverride: false };
    },
  });
  if (policy.status !== "registered") throw new Error("live policy registration refused: " + policy.detail);
  const service = createTreasuryService({
    getRooms: () => [Game.rooms[SOURCE_ROOM], Game.rooms[TARGET_ROOM]].filter((r): r is Room => Boolean(r)),
    // Deliberately use real default reservations/tasks and their health gates.
  });
  return createLiveCoordinator(c, {
    service,
    buildContract: (args, workKey) => buildTreasuryActionContract(service, { actionKind: LIVE_TRANSFER_KIND, transactionId: workKey, args }),
    noteObservedWorldChange: bumpTreasuryWorldSequence,
    log: event => console.log(JSON.stringify(event)),
  });
}
