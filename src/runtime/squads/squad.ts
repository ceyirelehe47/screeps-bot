/** 小队内核只接受 owner 提供的身份与策略，不解释具体任务 Memory。 */
export interface Squad {
  readonly owner: string;
  readonly taskId: string;
  readonly generation: string | number;
  readonly leader: Creep;
  readonly follower: Creep;
}
export function bindSquad(input: Squad, matches: (member: Creep, slot: "leader" | "follower") => boolean): Squad | undefined {
  if (input.leader === input.follower || !input.owner || !input.taskId ||
      !matches(input.leader, "leader") || !matches(input.follower, "follower")) return undefined;
  return Object.freeze({ ...input });
}
export function findSquadPartner(self: Creep, candidates: readonly Creep[], matches: (member: Creep) => boolean): Creep | undefined {
  return candidates.find(candidate => candidate !== self && matches(candidate));
}

let frame = -1;
let game: typeof Game | undefined;
const executed = new Map<string, unknown>();
/** 全队移动只执行一次；成员顺序与 source/target 双调用不会重发 intent。 */
export function claimSquadMovement(squad: Squad, revision: unknown = 0): boolean {
  if (frame !== Game.time || game !== Game) { frame = Game.time; game = Game; executed.clear(); }
  const key = JSON.stringify([squad.owner, squad.taskId, squad.generation, squad.leader.id ?? squad.leader.name, squad.follower.id ?? squad.follower.name]);
  if (executed.has(key) && executed.get(key) === revision) return false;
  executed.set(key, revision);
  return true;
}

