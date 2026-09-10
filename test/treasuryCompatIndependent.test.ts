/** Agent 独立反例轮的 Jest wrapper：运行 independent.spec.cjs（真实固定源
 * 读取器 + 候选实际 main.ts）。内部 Node 用例数不计入 Jest 用例数。 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("Treasury legacy read bridge — Agent independent counter-cases", () => {
  it("passes the five mandated counter-case groups without Memory writes", () => {
    const result = spawnSync(process.execPath, ["--test",
      resolve(__dirname, "treasury-compat/independent.spec.cjs")], {
      cwd: resolve(__dirname, ".."), encoding: "utf8", timeout: 45000,
    });
    if (result.status !== 0) throw new Error([result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"));
    expect(result.status).toBe(0);
  });
});
