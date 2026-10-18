import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function listProductionTypeScript(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listProductionTypeScript(absolute));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) result.push(absolute);
  }
  return result;
}

describe("War workflow lifecycle architecture boundaries", () => {
  it("keeps raw War owner deletion inside the War domain gateway", () => {
    const offenders: string[] = [];
    for (const file of listProductionTypeScript(path.join(ROOT, "src"))) {
      if (file.endsWith(path.join("runtime", "warControl.ts")) || file.startsWith(path.join(ROOT, "src/runtime/war") + path.sep)) continue;
      const source = fs.readFileSync(file, "utf8");
      if (/delete\s+Memory(?:\??\.)data(?:\??\.)war\s*\[/.test(source)) offenders.push(file);
      if (/delete\s+warStore\s*\[/.test(source)) offenders.push(file);
    }

    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
    expect(read("src/runtime/colonization.ts")).toContain("clearWarRoomTask(");
    expect(read("src/runtime/memoryCleanup.ts")).toContain("runRegisteredMemoryGc(");
    expect(read("src/runtime/registerTaskMemoryOwners.ts")).toContain("cleanupWarTasks(ownedRooms)");
    expect(read("src/runtime/war/api.ts")).toContain("releaseWarTaskOwner(targetRoom)");
    expect(read("src/runtime/console/operationsCommands.ts")).toContain("releaseWarTaskOwner(");
  });

  it("forbids role-name replacement as a War pairing source", () => {
    const offenders = listProductionTypeScript(path.join(ROOT, "src"))
      .filter((file) => /\.replace\(\s*["']:meleeAttacker:["']\s*,\s*["']:healer:["']\s*\)|\.replace\(\s*["']:healer:["']\s*,\s*["']:meleeAttacker:["']\s*\)/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    const melee = read("src/roles/meleeAttacker.ts");
    const healer = read("src/roles/healer.ts");

    expect(offenders).toEqual([]);
    expect(melee).toContain("_warPartnerConfigName");
    expect(healer).toContain("_warPartnerConfigName");
  });

  it("keeps the War writer independent from TaskSystem projection modules", () => {
    const source = [read("src/runtime/warControl.ts"), ...listProductionTypeScript(path.join(ROOT, "src/runtime/war")).map(file => fs.readFileSync(file, "utf8"))].join("\n");
    expect(source).not.toMatch(/from\s+["']@\/runtime\/taskSystem\//);
    expect(source).not.toMatch(/require\(["']@\/runtime\/taskSystem\//);
  });
});
