/** Node's real lab-tool suites are exercised under the normal Jest collection.
 * They mock only I/O ports; no game server or real process termination is used. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("Control Remediation I tool integration", () => {
  // "independent" 是 Agent 验收增补的独立场景（R01/R03 失败输入）。
  for (const suite of ["calibration", "memory", "stop", "independent"]) {
    it(`executes the ${suite} tool suite`, () => {
      const result = spawnSync(process.execPath, ["--test", join(__dirname, "tools", `${suite}.spec.cjs`)], {
        encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        throw new Error(`${suite} failed: ${String(result.error ?? result.status)}\n${result.stdout}\n${result.stderr}`);
      }
      expect(result.stdout).toMatch(/# fail 0/);
      expect(result.stdout).not.toMatch(/# tests 0\b/);
    }, 65000);
  }
});
