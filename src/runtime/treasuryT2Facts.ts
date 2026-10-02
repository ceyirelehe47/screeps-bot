import { TREASURY_T2_LANE, treasuryLaneWorkKey } from "@/runtime/treasuryTerminalLane";
export const TREASURY_T2_RUN_ID = TREASURY_T2_LANE.runId;
export const TREASURY_T2_ACTION_KIND = TREASURY_T2_LANE.actionKind;
export const TREASURY_T2_SOURCE_ROOM = TREASURY_T2_LANE.sourceRoom;
export const TREASURY_T2_TARGET_ROOM = TREASURY_T2_LANE.targetRoom;
export const TREASURY_T2_WORK_KEY_PREFIX = `biz:${TREASURY_T2_RUN_ID}:`;
export const treasuryT2WorkKey = (taskId: string): string => treasuryLaneWorkKey(TREASURY_T2_LANE, taskId);
export interface TreasuryT2EndpointFacts {
  readonly id: string; readonly resourceAmount: number; readonly energy: number;
  readonly used: number; readonly free: number; readonly capacity: number; readonly cooldown: number;
}
export interface DurableT2Facts {
  readonly schemaVersion: 1; readonly runId: string; readonly taskId: string; readonly taskCreatedAt: number;
  readonly amount: number; readonly tick: number; readonly quote: number; readonly username: string;
  readonly source: TreasuryT2EndpointFacts; readonly target: TreasuryT2EndpointFacts;
}
const DECIMAL = /^(0|[1-9][0-9]*)$/;
function integer(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function endpoint(v: TreasuryT2EndpointFacts): boolean {
  return typeof v?.id === "string" && v.id.length > 0 && v.id.length <= 100 && /^[A-Za-z0-9_.\-]+$/.test(v.id) &&
    [v.resourceAmount,v.energy,v.used,v.free,v.capacity,v.cooldown].every(integer) && v.used + v.free === v.capacity;
}
/** UH编码明确携带资源、两端及automatic用途；不会被旧H decoder解释。 */
export function encodeTreasuryT2DurableFacts(f: DurableT2Facts): string | null {
  if (f.schemaVersion !== 1 || f.runId !== TREASURY_T2_RUN_ID || typeof f.taskId !== "string" ||
      f.taskId.length < 1 || f.taskId.length > 80 || !/^[A-Za-z0-9:_.>\-]+$/.test(f.taskId) ||
      typeof f.username !== "string" || f.username.length < 1 || f.username.length > 32 || !/^[A-Za-z0-9_.\-]+$/.test(f.username) ||
      ![f.taskCreatedAt,f.amount,f.tick,f.quote].every(integer) || f.amount < 1 || f.amount > 100 || f.quote > 100 ||
      !endpoint(f.source) || !endpoint(f.target) || f.source.id === f.target.id) return null;
  const e = (v: TreasuryT2EndpointFacts) => [v.id,v.resourceAmount,v.energy,v.used,v.free,v.capacity,v.cooldown];
  const raw = ["t2", f.runId, "UH", "E4N58", "E1N57", "automatic", "synthesis:E1N57:UH2O",
    f.taskId,f.taskCreatedAt,f.amount,f.tick,f.quote,f.username,...e(f.source),...e(f.target)].join("|");
  return raw.length <= 512 ? raw : null;
}
export function decodeTreasuryT2DurableFacts(raw: unknown): DurableT2Facts | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const a = raw.split("|");
  if (a.length !== 27 || a[0] !== "t2" || a[1] !== TREASURY_T2_RUN_ID || a[2] !== "UH" ||
      a[3] !== "E4N58" || a[4] !== "E1N57" || a[5] !== "automatic" || a[6] !== "synthesis:E1N57:UH2O") return null;
  const n = (i: number) => DECIMAL.test(a[i]) ? Number(a[i]) : NaN;
  const e = (i: number): TreasuryT2EndpointFacts => ({id:a[i],resourceAmount:n(i+1),energy:n(i+2),used:n(i+3),free:n(i+4),capacity:n(i+5),cooldown:n(i+6)});
  const f: DurableT2Facts = {schemaVersion:1,runId:a[1],taskId:a[7],taskCreatedAt:n(8),amount:n(9),tick:n(10),quote:n(11),username:a[12],source:e(13),target:e(20)};
  return encodeTreasuryT2DurableFacts(f) === raw ? f : null;
}
