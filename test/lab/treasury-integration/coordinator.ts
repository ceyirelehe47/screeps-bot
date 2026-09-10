/** Business coordination, not a second ledger. All persisted work and occupancy
 * remain in the unchanged Treasury service/kernel. Reconstructed after reset. */
import type { TreasuryService } from "@/runtime/treasury/facade";
import type { LabExperimentConfig } from "../terminal-transfer/labConfig";
import { readControlRecord } from "../terminal-transfer/controlRecord";
import { LIVE_TRANSFER_KIND, LIVE_TRANSFER_SEMANTICS, prepareLiveTransfer, encodeLivePayload,
  decodeLivePayload, validateLiveArgs, reconcileLiveTransfer, type LiveTransferArgs } from "./adapter";

export interface LiveCoordinatorDeps {
  readonly service: TreasuryService;
  readonly buildContract: (args: LiveTransferArgs, workKey: string) => { status: string; contract?: unknown; reason?: string };
  /** Existing observation world-sequence hook. Called only after an exact
   * transaction AND current-world match, never merely because time advanced. */
  readonly noteObservedWorldChange: () => void;
  readonly log: (event: object) => void;
}
export type LiveAdmission = { status: "admitted"; attemptId: string; args: LiveTransferArgs; dispatch: unknown }
  | { status: "rejected"; reason: string };

export function createLiveCoordinator(config: LabExperimentConfig, deps: LiveCoordinatorDeps) {
  const c = Object.freeze({ ...config });
  const service = deps.service;
  const defaultWorkKey = "biz:terminal-lab:" + c.experimentId;
  function emit(event: object) { deps.log({ experimentId: c.experimentId, tick: Game.time, ...event }); }
  function journal() {
    const j = service.kernelJournal();
    if (!["healthy", "absent"].includes(j.health.status) || j.legacyStores.length) throw new Error("treasury journal not a healthy isolated world");
    return j;
  }
  function pristine() {
    const r = readControlRecord();
    return r.status === "ok" && r.record.experimentId === c.experimentId && r.record.armed === true
      && r.record.attempted === false && r.record.stopped !== true && r.record.attemptedTick === undefined && r.record.syncResult === undefined;
  }
  function projection() {
    const read = (room: string, resource: string) => {
      const v = service.query({ resource, rooms: [room], locations: ["terminal"], allowProjected: false,
        allowIncoming: false, subtractOutgoing: true, subtractReservations: true, withhold: 0 });
      return { observed: v.observed, committed: v.committed, spendable: v.spendable, authorizationSafe: v.authorizationSafe,
        blockers: [...v.authorizationBlockers] };
    };
    return { sourceH: read(c.sourceRoomName, "H"), sourceEnergy: read(c.sourceRoomName, "energy"),
      targetH: read(c.targetRoomName, "H"), targetRiskAdjustedFree: service.riskAdjustedFreeCapacity(c.targetRoomName, "terminal") };
  }
  function state(stage: string) {
    const j = journal();
    const value = { kind: "lab-treasury-state", stage, health: j.health,
      active: j.active.map(r => ({ attemptId: r.attemptId, workKey: r.workKey, actionKind: r.identity.actionKind,
        phase: r.phase, outcome: r.outcome })), projection: projection() };
    emit(value);
    return value;
  }
  function request(workKey = defaultWorkKey): LiveAdmission {
    try {
      // Inspect the persisted active set on EVERY request. No heap busy flag.
      if (journal().active.length) return { status: "rejected", reason: "single_flight_active" };
      if (!pristine()) return { status: "rejected", reason: "control_not_pristine_armed" };
      const args = prepareLiveTransfer(c);
      const built = deps.buildContract(args, workKey);
      if (built.status !== "built") return { status: "rejected", reason: "build:" + String(built.reason ?? built.status) };
      const admitted = service.authorizeTreasuryActionContract(built.contract, { workKey });
      if (admitted.status !== "admitted") return { status: "rejected", reason: "admission:" + JSON.stringify(admitted) };
      return { status: "admitted", attemptId: admitted.attemptId, dispatch: admitted.dispatch, args };
    } catch (error) { return { status: "rejected", reason: String(error).slice(0, 160) }; }
  }
  function execute(admission: LiveAdmission) {
    if (admission.status !== "admitted") return { status: "rejected", reason: "not_admitted" };
    try {
      const j = journal(), record = j.active.find(r => r.attemptId === admission.attemptId);
      if (j.active.length !== 1 || !record || record.phase !== "pending" || record.identity.actionKind !== LIVE_TRANSFER_KIND) return { status: "rejected", reason: "not_the_single_pending_work" };
      if (!pristine() || encodeLivePayload(prepareLiveTransfer(c)) !== encodeLivePayload(admission.args)) return { status: "rejected", reason: "prepared_facts_changed" };
      return service.executeAuthorizedDispatch(admission.dispatch);
    } catch (error) { return { status: "rejected", reason: String(error).slice(0, 160) }; }
  }
  function reconcilePendingOutcome() {
    for (const record of journal().active) {
      if (record.identity.actionKind !== LIVE_TRANSFER_KIND || record.phase !== "outcome_unknown") continue;
      const a = decodeLivePayload(record.identity.durableFacts?.payload);
      if (!a || validateLiveArgs(a, c) !== null || record.identity.adapterVersion !== 1
          || record.identity.adapterSemanticIdentity !== LIVE_TRANSFER_SEMANTICS) continue;
      const read = reconcileLiveTransfer(a, service.observation());
      if (read.conclusion === "observed_committed") {
        // A real asynchronous engine update cannot call a JS fake-host hook.
        // Publish only the already-verified world change to the EXISTING
        // sequence domain, then let the registered reconciler independently
        // run again inside settleUnknownOutcome. No self-issued receipt.
        deps.noteObservedWorldChange();
        service.observation();
      }
      const result = service.settleUnknownOutcome({ attemptId: record.attemptId });
      emit({ kind: "lab-treasury-settle", attemptId: record.attemptId, candidate: read, result });
    }
  }
  function tick() {
    service.beginTick();
    try {
      state("before");
      if (Game.time === c.targetTick) {
        const admission = request();
        if (admission.status !== "admitted") {
          emit({ kind: "lab-precondition-rejection", reason: admission.reason });
        } else {
          state("admitted");
          const result = execute(admission);
          emit({ kind: "lab-treasury-dispatch", attemptId: admission.attemptId, result });
          state("dispatched");
          if (result.status === "rejected") emit({ kind: "lab-precondition-rejection", reason: "treasury_dispatch_rejected" });
        }
      } else if (Game.time > c.targetTick) {
        reconcilePendingOutcome();
        state("reconciled");
      }
    } finally {
      service.endTick();
      state("end");
    }
  }
  return { request, execute, reconcilePendingOutcome, projection, state, tick };
}
