import { spawnSync } from "node:child_process";
import { join } from "node:path";
describe("Treasury integration tools", () => {
  for (const suite of ["local", "process", "tooling"]) {
    it(`executes ${suite} independent Node tests`, () => {
      const r = spawnSync(process.execPath, ["--test", join(__dirname, `${suite}.spec.cjs`)], {
        encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      });
      if (r.error || r.status !== 0) throw Error(`${String(r.error ?? r.status)}\n${r.stdout}\n${r.stderr}`);
      expect(r.stdout).toMatch(/# fail 0/); expect(r.stdout).not.toMatch(/# tests 0\b/);
    }, 65000);
  }
});
