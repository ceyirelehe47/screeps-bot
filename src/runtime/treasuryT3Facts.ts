import { TREASURY_T3_LANE, treasuryLaneWorkKey } from "@/runtime/treasuryTerminalLane";
export const TREASURY_T3_RUN_ID = TREASURY_T3_LANE.runId;
export const TREASURY_T3_ACTION_KIND = TREASURY_T3_LANE.actionKind;
export const TREASURY_T3_SOURCE_ROOM = TREASURY_T3_LANE.sourceRoom;
export const TREASURY_T3_TARGET_ROOM = TREASURY_T3_LANE.targetRoom;
export const TREASURY_T3_WORK_KEY_PREFIX = `biz:${TREASURY_T3_RUN_ID}:`;
export const treasuryT3WorkKey = (taskId: string): string => treasuryLaneWorkKey(TREASURY_T3_LANE, taskId);
export interface TreasuryT3EndpointFacts {
  readonly id: string; readonly resourceAmount: number; readonly energy: number;
  readonly used: number; readonly free: number; readonly capacity: number; readonly cooldown: number;
}
export interface DurableT3Facts {
  readonly schemaVersion: 1; readonly runId: string; readonly taskId: string; readonly taskCreatedAt: number;
  readonly amount: number; readonly tick: number; readonly quote: number; readonly username: string;
  readonly source: TreasuryT3EndpointFacts; readonly target: TreasuryT3EndpointFacts;
}
const DECIMAL = /^(0|[1-9][0-9]*)$/;
function integer(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function endpoint(v: TreasuryT3EndpointFacts): boolean {
  return typeof v?.id === "string" && v.id.length > 0 && v.id.length <= 100 && /^[A-Za-z0-9_.\-]+$/.test(v.id) &&
    [v.resourceAmount,v.energy,v.used,v.free,v.capacity,v.cooldown].every(integer) && v.used + v.free === v.capacity;
}
/** OH 编码拥有独立身份；旧 H/UH decoder 不会把它当成历史首片。 */
export function encodeTreasuryT3DurableFacts(f: DurableT3Facts): string | null {
  if (f.schemaVersion !== 1 || f.runId !== TREASURY_T3_RUN_ID || typeof f.taskId !== "string" ||
      f.taskId.length < 1 || f.taskId.length > 80 || !/^[A-Za-z0-9:_.>\-]+$/.test(f.taskId) ||
      typeof f.username !== "string" || f.username.length < 1 || f.username.length > 32 || !/^[A-Za-z0-9_.\-]+$/.test(f.username) ||
      ![f.taskCreatedAt,f.amount,f.tick,f.quote].every(integer) || f.amount < 1 || f.amount > 100 || f.quote > 100 ||
      !endpoint(f.source) || !endpoint(f.target) || f.source.id === f.target.id) return null;
  const e = (v: TreasuryT3EndpointFacts) => [v.id,v.resourceAmount,v.energy,v.used,v.free,v.capacity,v.cooldown];
  const raw = ["t3", f.runId, "OH", "E4N58", "E1N57", "automatic", "synthesis:E1N57:UH2O",
    f.taskId,f.taskCreatedAt,f.amount,f.tick,f.quote,f.username,...e(f.source),...e(f.target)].join("|");
  return raw.length <= 512 ? raw : null;
}
export function decodeTreasuryT3DurableFacts(raw: unknown): DurableT3Facts | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const a = raw.split("|");
  if (a.length !== 27 || a[0] !== "t3" || a[1] !== TREASURY_T3_RUN_ID || a[2] !== "OH" ||
      a[3] !== "E4N58" || a[4] !== "E1N57" || a[5] !== "automatic" || a[6] !== "synthesis:E1N57:UH2O") return null;
  const n = (i: number) => DECIMAL.test(a[i]) ? Number(a[i]) : NaN;
  const e = (i: number): TreasuryT3EndpointFacts => ({id:a[i],resourceAmount:n(i+1),energy:n(i+2),used:n(i+3),free:n(i+4),capacity:n(i+5),cooldown:n(i+6)});
  const f: DurableT3Facts = {schemaVersion:1,runId:a[1],taskId:a[7],taskCreatedAt:n(8),amount:n(9),tick:n(10),quote:n(11),username:a[12],source:e(13),target:e(20)};
  return encodeTreasuryT3DurableFacts(f) === raw ? f : null;
}
