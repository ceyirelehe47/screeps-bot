import { bindSquad, claimSquadMovement, findSquadPartner } from "./squad";
type PairMember = Creep & { memory: CreepMemory & { pairGeneration: number } };
it("binds exact owner slots and generations, and executes once regardless of member order", () => {
  const leader = { id: "r", memory: { role: "powerBankAttacker", pairGeneration: 2 } } as unknown as PairMember;
  const follower = { id: "g", memory: { role: "powerBankHealer", pairGeneration: 2 } } as unknown as PairMember;
  const input = { owner: "pb", taskId: "b", generation: 2, leader, follower };
  const matches = (member: Creep, slot: string) => (member as PairMember).memory.pairGeneration === 2 && member.memory.role === (slot === "leader" ? "powerBankAttacker" : "powerBankHealer");
  const squad = bindSquad(input, matches)!;
  Game.time++; expect(claimSquadMovement(squad)).toBe(true); expect(claimSquadMovement({ ...squad })).toBe(false);
  Game.time++; expect(claimSquadMovement(squad)).toBe(true);
  follower.memory.pairGeneration = 1; expect(bindSquad(input, matches)).toBeUndefined();
  expect(bindSquad({ ...input, follower: leader }, () => true)).toBeUndefined();
  expect(findSquadPartner(leader, [leader, follower], c => c === follower)).toBe(follower);
});
