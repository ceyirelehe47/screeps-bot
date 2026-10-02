import { TREASURY_T4_LANE, treasuryLaneWorkKey } from "@/runtime/treasuryTerminalLane";
export const TREASURY_T4_RUN_ID = TREASURY_T4_LANE.runId;
export const TREASURY_T4_ACTION_KIND = TREASURY_T4_LANE.actionKind;
export const TREASURY_T4_SOURCE_ROOM = TREASURY_T4_LANE.sourceRoom;
export const TREASURY_T4_TARGET_ROOM = TREASURY_T4_LANE.targetRoom;
export const TREASURY_T4_WORK_KEY_PREFIX = `biz:${TREASURY_T4_RUN_ID}:`;
export const treasuryT4WorkKey = (taskId: string, sequence?: number): string => treasuryLaneWorkKey(TREASURY_T4_LANE, taskId, sequence);
export interface TreasuryT4EndpointFacts {
  readonly id: string; readonly resourceAmount: number; readonly energy: number;
  readonly used: number; readonly free: number; readonly capacity: number; readonly cooldown: number;
}
export interface DurableT4Facts {
  readonly schemaVersion: 1; readonly runId: string; readonly sequence: number; readonly taskId: string; readonly taskCreatedAt: number;
  readonly amount: number; readonly tick: number; readonly quote: number; readonly username: string;
  readonly source: TreasuryT4EndpointFacts; readonly target: TreasuryT4EndpointFacts;
}
const DECIMAL = /^(0|[1-9][0-9]*)$/;
function integer(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function endpoint(v: TreasuryT4EndpointFacts): boolean {
  return typeof v?.id === "string" && v.id.length > 0 && v.id.length <= 100 && /^[A-Za-z0-9_.\-]+$/.test(v.id) &&
    [v.resourceAmount,v.energy,v.used,v.free,v.capacity,v.cooldown].every(integer) && v.used + v.free === v.capacity;
}
/** 持续 OH 事实持久绑定 cycle 序号；旧首片解码器拒绝本格式。 */
export function encodeTreasuryT4DurableFacts(f: DurableT4Facts): string | null {
  if (f.schemaVersion !== 1 || f.runId !== TREASURY_T4_RUN_ID || typeof f.taskId !== "string" ||
      f.taskId.length < 1 || f.taskId.length > 80 || !/^[A-Za-z0-9:_.>\-]+$/.test(f.taskId) ||
      typeof f.username !== "string" || f.username.length < 1 || f.username.length > 32 || !/^[A-Za-z0-9_.\-]+$/.test(f.username) ||
      ![f.taskCreatedAt,f.amount,f.tick,f.quote,f.sequence].every(integer) || f.sequence < 1 || f.sequence > 128 || f.amount < 1 || f.amount > 26 || f.quote > 100 ||
      !endpoint(f.source) || !endpoint(f.target) || f.source.id === f.target.id) return null;
  const e = (v: TreasuryT4EndpointFacts) => [v.id,v.resourceAmount,v.energy,v.used,v.free,v.capacity,v.cooldown];
  const raw = ["t4", f.runId, "OH", "E4N58", "E1N57", "automatic", "synthesis:E1N57:UH2O",
    f.sequence,f.taskId,f.taskCreatedAt,f.amount,f.tick,f.quote,f.username,...e(f.source),...e(f.target)].join("|");
  return raw.length <= 512 ? raw : null;
}
export function decodeTreasuryT4DurableFacts(raw: unknown): DurableT4Facts | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const a = raw.split("|");
  if (a.length !== 28 || a[0] !== "t4" || a[1] !== TREASURY_T4_RUN_ID || a[2] !== "OH" ||
      a[3] !== "E4N58" || a[4] !== "E1N57" || a[5] !== "automatic" || a[6] !== "synthesis:E1N57:UH2O") return null;
  const n = (i: number) => DECIMAL.test(a[i]) ? Number(a[i]) : NaN;
  const e = (i: number): TreasuryT4EndpointFacts => ({id:a[i],resourceAmount:n(i+1),energy:n(i+2),used:n(i+3),free:n(i+4),capacity:n(i+5),cooldown:n(i+6)});
  const f: DurableT4Facts = {schemaVersion:1,runId:a[1],sequence:n(7),taskId:a[8],taskCreatedAt:n(9),amount:n(10),tick:n(11),quote:n(12),username:a[13],source:e(14),target:e(21)};
  return encodeTreasuryT4DurableFacts(f) === raw ? f : null;
}
