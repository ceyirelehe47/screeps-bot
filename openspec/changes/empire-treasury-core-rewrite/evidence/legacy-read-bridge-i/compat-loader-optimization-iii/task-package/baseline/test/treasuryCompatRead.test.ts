/** Runs bridge logic and the pinned REAL read builders in the old-base candidate.
 * Internal Node case count is not added to the Jest test count. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("Treasury old-production read compatibility bridge", () => {
  it("passes bridge boundaries and actual pinned reader compatibility without Memory writes", () => {
    const result = spawnSync(process.execPath, ["--test",
      resolve(__dirname, "treasury-compat/bridge.spec.cjs"),
      resolve(__dirname, "treasury-compat/real-readers.spec.cjs")], {
      cwd: resolve(__dirname, ".."), encoding: "utf8", timeout: 45000,
    });
    if (result.status !== 0) throw new Error([result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"));
    expect(result.status).toBe(0);
  });
});
