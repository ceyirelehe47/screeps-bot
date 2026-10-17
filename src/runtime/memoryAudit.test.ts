import { buildMemoryAuditSnapshot } from "@/runtime/memoryAudit";
import { runInNewContext } from "vm";

describe("buildMemoryAuditSnapshot", () => {

  it("returns empty result for null/undefined input", () => {
    expect(buildMemoryAuditSnapshot(null)).toEqual({ totalBytes: 0, branches: [], top: [] });
    expect(buildMemoryAuditSnapshot(undefined)).toEqual({ totalBytes: 0, branches: [], top: [] });
  });

  it("handles nested objects up to maxDepth and stops", () => {
    // depth 0: root keys
    // depth 1: a
    // depth 2: b
    // depth 3: c
    // depth 4: d
    // depth 5: e
    // depth 6: f — should NOT be traversed (maxDepth=6 stops at depth 6)
    const mem = {
      a: {
        b: {
          c: {
            d: {
              e: {
                f: { value: "deep" },
              },
            },
          },
        },
      },
    };

    const result = buildMemoryAuditSnapshot(mem, { maxDepth: 6 });

    // Should have branches: a, a.b, a.b.c, a.b.c.d, a.b.c.d.e — 5 branches
    // a.b.c.d.e.f should NOT appear because depth 6 >= maxDepth 6
    const paths = result.branches.map((b) => b.path);
    expect(paths).toContain("a");
    expect(paths).toContain("a.b");
    expect(paths).toContain("a.b.c");
    expect(paths).toContain("a.b.c.d");
    expect(paths).toContain("a.b.c.d.e");
    expect(paths).not.toContain("a.b.c.d.e.f");
  });
});

it("引擎其他 realm 和无原型 Memory 对象仍可分支统计", () => {
  const crossRealm = runInNewContext('({data:{roomPlanner:{layout:[1,2,3]}}})');
  expect(buildMemoryAuditSnapshot(crossRealm, { maxDepth: 3 }).branches.map(branch => branch.path)).toEqual(["data", "data.roomPlanner"]);
  const data = Object.assign(Object.create(null), { cfg: { constructor: "普通用户字段", enabled: true } });
  expect(buildMemoryAuditSnapshot(data, { maxDepth: 2 }).branches[0].path).toBe("cfg");
});

it("按 UTF-8 计算中文及 emoji，不把 code unit 数当字节数", () => {
  const memory = { cfg: { label: "中文🚀" } };
  const result = buildMemoryAuditSnapshot(memory, { maxDepth: 2 });
  expect(result.totalBytes).toBe(Buffer.byteLength(JSON.stringify(memory)));
  expect(result.branches).toContainEqual({ path: "cfg", bytes: Buffer.byteLength(JSON.stringify(memory.cfg)) });
});
