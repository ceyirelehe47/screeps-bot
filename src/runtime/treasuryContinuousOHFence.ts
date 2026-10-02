import { readTreasuryContinuousOHState } from "@/runtime/treasuryContinuousOHState";
import { treasuryContinuousOHDataToken as token } from "@/runtime/treasuryContinuousOHDataTree";
import { readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryWorldSequence } from "@/runtime/treasury/observation";
import type { Control, Read } from "@/runtime/treasuryFirstLiveState";
import type { TreasuryT1Quota } from "@/runtime/treasuryTerminalResponsibility";

type QuotaRead = {readonly status:"absent"} | {readonly status:"invalid"} |
  {readonly status:"valid"; readonly value:TreasuryT1Quota};
export interface TreasuryContinuousOHFenceProjection { readonly control: Read; readonly quota: QuotaRead; readonly closed: ReadonlySet<string>; }
type Projection = TreasuryContinuousOHFenceProjection;
interface Cache { game:Game; memory:Memory; tick:number; revision:number; worldSequence:number;
  primary:unknown; mirror:unknown; token:string; projection:Projection; }
let cached: Cache | null = null;

/** 只供 cargo fence；永不用于 intake、预算发布或 native 的授权判断。 */
function projection(): Projection {
  try {
    const runtime = Memory.runtime as unknown as Record<string,unknown> | undefined;
    if (runtime !== undefined && (runtime === null || typeof runtime !== "object" || Array.isArray(runtime) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(runtime)))) {
      return {control:{status:"invalid"},quota:{status:"invalid"},closed:new Set()};
    }
    const primarySlot = runtime && Object.getOwnPropertyDescriptor(runtime, "treasuryContinuousOH");
    const mirrorSlot = runtime && Object.getOwnPropertyDescriptor(runtime, "treasuryContinuousOHMirror");
    if ([primarySlot, mirrorSlot].some((slot) => slot && (!("value" in slot) || !slot.enumerable)) ||
        runtime && (!primarySlot && "treasuryContinuousOH" in runtime || !mirrorSlot && "treasuryContinuousOHMirror" in runtime)) {
      return {control:{status:"invalid"},quota:{status:"invalid"},closed:new Set()};
    }
    const primary = primarySlot?.value; const mirror = mirrorSlot?.value;
    const first = token(primary); const second = token(mirror);
    if (first === null || second === null) return {control:{status:"invalid"},quota:{status:"invalid"},closed:new Set()};
    const signature = `${first}\n${second}`;
    const revision = readTreasuryCommitmentRevision(); const worldSequence = readTreasuryWorldSequence();
    if (cached?.game === Game && cached.memory === Memory && cached.tick === Game.time &&
        cached.revision === revision && cached.worldSequence === worldSequence && cached.primary === primary &&
        cached.mirror === mirror && cached.token === signature) return cached.projection;
    const read = readTreasuryContinuousOHState();
    let result: Projection;
    if (read.status !== "valid") result = {control:read,quota:read,closed:new Set()};
    else {
      const state = read.value; const cycle = state.currentCycle;
      const control: Control = {
        schemaVersion:1,runId:state.runId,
        status:cycle?.status ?? (state.sessionStatus === "stopped" || state.sessionStatus === "stopping" ? "closed" : "active"),
        startedAtTick:cycle?.startedAtTick ?? state.enabledAtTick,startedAtMs:cycle?.startedAtMs ?? state.enabledAtMs,
        deadlineTick:cycle?.deadlineTick ?? state.deadlineTick,deadlineMs:cycle?.deadlineMs ?? state.deadlineMs,
        lastHeartbeatAtMs:cycle?.lastHeartbeatAtMs ?? state.enabledAtMs,controlUntilMs:cycle?.controlUntilMs ?? state.deadlineMs,
        taskId:cycle?.taskId ?? "",taskCreatedAt:cycle?.taskCreatedAt ?? 0,taskAmount:cycle?.taskAmount ?? 0,
        taskRemainingAtArm:cycle?.taskRemainingAtArm ?? 0,sourceTerminalId:state.sourceTerminalId,
        targetTerminalId:state.targetTerminalId,deployTag:state.deployTag,deployBundleHash:state.deployBundleHash,
        closeReason:cycle?.closeReason ?? state.stopReason,maxSliceAmount:cycle?.amount ?? 0,
        sequence:cycle?.sequence ?? 0,hash:state.hash,
      };
      result = {control:{status:"valid",value:Object.freeze(control)},
        quota:cycle?.quota ? {status:"valid",value:Object.freeze({...cycle.quota})} : {status:"absent"},
        closed:new Set(state.closedCycles.flatMap((cert) => cert.ring && cert.cycle.quota?.status === "drained"
          ? [`${cert.ring.workKey}\n${cert.ring.attemptId}`] : []))};
    }
    cached = {game:Game,memory:Memory,tick:Game.time,revision,worldSequence,primary,mirror,token:signature,projection:result};
    return result;
  } catch { return {control:{status:"invalid"},quota:{status:"invalid"},closed:new Set()}; }
}
export function readTreasuryContinuousOHFenceControl(): Read { return projection().control; }
export function readTreasuryContinuousOHFenceQuota(): QuotaRead { return projection().quota; }
export function readTreasuryContinuousOHFenceProjection(): TreasuryContinuousOHFenceProjection { return projection(); }
export function continuousFenceClosedWorkAcknowledged(workKey: string, attemptId: string): boolean {
  return projection().closed.has(`${workKey}\n${attemptId}`);
}
