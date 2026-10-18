import { continueCreepRetirement, retireCreepMemory } from "@/runtime/retirement";

it("旧战争返仓字段迁移后保留目的地，重复解绑不丢失货物角色参数", () => {
  const memory: CreepMemory = { role: "healer", roleArgs: ["W1N1"], configName: "war-old", _warRetireToRoom: "W2N2", _warPartnerConfigName: "partner" };
  retireCreepMemory(memory, { owner: "war", mode: "detach" });
  retireCreepMemory(memory, { owner: "war", mode: "detach" });
  expect(memory).toMatchObject({ role: "healer", roleArgs: ["W1N1"], _warDetached: true, _recycleToRoom: "W2N2" });
  expect(memory.configName).toBeUndefined(); expect(memory._warPartnerConfigName).toBeUndefined(); expect(memory._warRetireToRoom).toBeUndefined();
});

it("出生中退役请求保留到原生 suicide 可执行，再返回已处理阻止业务继续", () => {
  const creep = { memory: { role: "worker" }, spawning: true, suicide: jest.fn(() => ERR_BUSY) } as unknown as Creep;
  retireCreepMemory(creep.memory, { owner: "workforce", mode: "suicide" });
  expect(continueCreepRetirement(creep)).toBe(true);
  expect(creep.suicide).not.toHaveBeenCalled();
  (creep as Creep & { spawning: boolean }).spawning = false;
  expect(continueCreepRetirement(creep)).toBe(true); expect(creep.memory._retireSuicideOwner).toBe("workforce");
  Game.time++; jest.mocked(creep.suicide).mockReturnValue(OK);
  expect(continueCreepRetirement(creep)).toBe(true); expect(creep.memory._retireSuicideOwner).toBe("workforce");
  continueCreepRetirement(creep); expect(creep.suicide).toHaveBeenCalledTimes(2);
});
