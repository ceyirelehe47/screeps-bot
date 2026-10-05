import {
  ROLE_CATALOG,
  isRoleName,
  type RoleName,
} from "@/types/roleCatalog";

const EXPECTED_ROLES = [
  "harvester",
  "mineralHarvester",
  "miner",
  "carrier",
  "worker",
  "upgrader",
  "hubUpgrader",
  "scout",
  "claimer",
  "colonizerHarvester",
  "colonizerWorker",
  "colonizerUpgrader",
  "meleeAttacker",
  "healer",
  "homeDefender",
  "crossShardClaimer",
  "crossShardColonizerHarvester",
  "crossShardColonizerWorker",
  "flagScout",
  "remoteCarrier",
  "remoteMiningCarrier",
  "powerBankScout",
  "powerBankAttacker",
  "powerBankHealer",
  "powerBankHauler",
  "depositHarvester",
  "remoteMiningReserver",
  "remoteWorker",
  "remoteDefender",
] as const;

type ExpectedRoleName = (typeof EXPECTED_ROLES)[number];
type ExpectedRoleGuard = (value: unknown) => value is RoleName;
type IsExactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

const roleNameMatchesExpected: IsExactly<RoleName, ExpectedRoleName> = true;
const roleGuardMatchesExpected: IsExactly<typeof isRoleName, ExpectedRoleGuard> = true;

function assertRoleNameNarrowing(value: unknown): void {
  if (isRoleName(value)) {
    const roleName: RoleName = value;
    void roleName;
  }
}

void roleNameMatchesExpected;
void roleGuardMatchesExpected;
void assertRoleNameNarrowing;

describe("roleCatalog", () => {
  it("contains exactly the 29 supported role identities", () => {
    expect(Object.keys(ROLE_CATALOG).sort()).toEqual(
      [...EXPECTED_ROLES].sort(),
    );
  });

  it("marks only hubUpgrader as legacy and exposes a frozen catalog", () => {
    const activeRoles = Object.entries(ROLE_CATALOG)
      .filter(([, lifecycle]) => lifecycle === "active")
      .map(([role]) => role)
      .sort();
    const legacyRoles = Object.entries(ROLE_CATALOG)
      .filter(([, lifecycle]) => lifecycle === "legacy")
      .map(([role]) => role);

    expect(activeRoles).toEqual(
      EXPECTED_ROLES.filter((role) => role !== "hubUpgrader").sort(),
    );
    expect(activeRoles).toHaveLength(28);
    expect(legacyRoles).toEqual(["hubUpgrader"]);
    expect(Object.isFrozen(ROLE_CATALOG)).toBe(true);
  });

  describe("isRoleName", () => {
    it("accepts every supported role", () => {
      for (const role of EXPECTED_ROLES) {
        expect(isRoleName(role)).toBe(true);
      }
    });

    it("rejects unsupported, inherited, and non-string values", () => {
      for (const value of [
        "unknownRole",
        "",
        "constructor",
        "toString",
        "__proto__",
        undefined,
        null,
        0,
        1,
        true,
        false,
        {},
        [],
        Symbol("role"),
      ]) {
        expect(isRoleName(value)).toBe(false);
      }
    });
  });
});
