import {
  doesCreepBodyMatch,
  getMismatchedMinerRetirements,
} from "@/runtime/minerBodyPolicy";
import { getLinkMinerBodyForRegenSourceLevel } from "@/config/spawnProfiles";

function createMiner(
  name: string,
  body: BodyPartConstant[],
  inSourceRange: boolean,
  adjacentMinerNames: string[] = [],
): Creep {
  return {
    name,
    body: body.map((type) => ({ type, hits: 100 })),
    pos: {
      inRangeTo: jest.fn((target: RoomObject) => {
        if ((target as Source).id === "source-a") {
          return inSourceRange;
        }
        return adjacentMinerNames.includes((target as Creep).name);
      }),
    } as unknown as RoomPosition,
    suicide: jest.fn(() => OK),
  } as unknown as Creep;
}

describe("minerBodyPolicy", () => {
  const oldBody = [
    ...Array<BodyPartConstant>(12).fill(WORK),
    ...Array<BodyPartConstant>(6).fill(CARRY),
    ...Array<BodyPartConstant>(5).fill(MOVE),
  ];
  const newBody = getLinkMinerBodyForRegenSourceLevel(4);
  const source = { id: "source-a" } as Source;

  it("retires only the mismatched miner after the replacement reaches the Source", () => {
    const oldMiner = createMiner("old", oldBody, true);
    const replacement = createMiner("replacement", newBody, true);

    expect(getMismatchedMinerRetirements([oldMiner, replacement], source, newBody)).toEqual([oldMiner]);

    expect(doesCreepBodyMatch(replacement, newBody)).toBe(true);
    expect(oldMiner.suicide).not.toHaveBeenCalled();
    expect(replacement.suicide).not.toHaveBeenCalled();
  });

  it("hands off from an occupied single-access Source when the replacement reaches the staging tile", () => {
    const oldMiner = createMiner("old", oldBody, true);
    const replacement = createMiner("replacement", newBody, false, ["old"]);

    expect(getMismatchedMinerRetirements([oldMiner, replacement], source, newBody)).toEqual([oldMiner]);

    expect(oldMiner.suicide).not.toHaveBeenCalled();
    expect(replacement.suicide).not.toHaveBeenCalled();
  });
  it("keeps the incumbent while the matching replacement is spawning or still travelling", () => {
    const oldMiner = createMiner("old", oldBody, true);
    const replacement = createMiner("replacement", newBody, false);
    expect(getMismatchedMinerRetirements([oldMiner, replacement], source, newBody)).toEqual([]);
    replacement.spawning = true;
    replacement.pos.inRangeTo = jest.fn(() => true);
    expect(getMismatchedMinerRetirements([oldMiner, replacement], source, newBody)).toEqual([]);
  });

});
