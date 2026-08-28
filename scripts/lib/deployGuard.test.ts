/**
 * 部署守卫纯函数测试（阶段 B）：
 * - 脏工作树（含 untracked）在生产部署时被拒绝；显式 override 放行但如实记录；
 * - HEAD 无法解析 / detached（branch=auto）被拒绝；
 * - modules 哈希稳定（相同内容同哈希）且内容变化即变化；
 * - 回读比对：一致 / 缺失 / 内容差异的判定。
 *
 * deployGuard.cjs 是 rollup（ESM named-import CJS）与测试（CJS require）共用的
 * 纯函数库，不直接执行 git 命令（命令执行由调用方注入，便于测试）。
 */
import { createHash } from "node:crypto";

interface DeployGuardModule {
  DEPLOY_GUARD_ERROR: string;
  parseGitStatusPorcelain(output: string): {
    entries: string[];
    dirty: boolean;
    staged: boolean;
    untracked: boolean;
  };
  assertDeployableGitState(input: {
    statusOutput: string;
    headSha: string;
    currentBranch: string;
    configuredBranch: string;
    allowDirty?: boolean;
  }): { branch: string; dirty: boolean };
  computeModulesHash(modules: Record<string, string | { binary: string }>): string;
  diffRemoteModules(
    localModules: Record<string, string | { binary: string }>,
    remoteModules: Record<string, string | { binary: string }> | undefined,
  ): {
    match: boolean;
    localHash: string;
    remoteHash: string | null;
    missing: string[];
    extra: string[];
    changed: string[];
  };
}

const deployGuard = require("./deployGuard.cjs") as DeployGuardModule;

const CLEAN_SHA = "a".repeat(40);

describe("parseGitStatusPorcelain", () => {
  it("treats empty output as clean", () => {
    const status = deployGuard.parseGitStatusPorcelain("");
    expect(status.dirty).toBe(false);
    expect(status.staged).toBe(false);
    expect(status.untracked).toBe(false);
  });

  it("detects staged, unstaged and untracked entries", () => {
    const status = deployGuard.parseGitStatusPorcelain(
      ["M  src/a.ts", " M src/b.ts", "?? notes.txt"].join("\n"),
    );
    expect(status.dirty).toBe(true);
    expect(status.staged).toBe(true);
    expect(status.untracked).toBe(true);
    expect(status.entries).toHaveLength(3);
  });
});

describe("assertDeployableGitState", () => {
  it("accepts a clean tree with resolved HEAD and explicit branch", () => {
    const result = deployGuard.assertDeployableGitState({
      statusOutput: "",
      headSha: CLEAN_SHA,
      currentBranch: "cpu-canary-market-safe",
      configuredBranch: "default",
    });
    expect(result).toEqual({ branch: "default", dirty: false });
  });

  it("resolves branch=auto from the current git branch", () => {
    const result = deployGuard.assertDeployableGitState({
      statusOutput: "",
      headSha: CLEAN_SHA,
      currentBranch: "cpu-canary-market-safe",
      configuredBranch: "auto",
    });
    expect(result.branch).toBe("cpu-canary-market-safe");
  });

  it("rejects a dirty working tree for production push", () => {
    expect.hasAssertions();
    try {
      deployGuard.assertDeployableGitState({
        statusOutput: " M src/main.ts",
        headSha: CLEAN_SHA,
        currentBranch: "main",
        configuredBranch: "default",
      });
    } catch (error) {
      const guardError = error as Error & { code?: string; errors?: string[] };
      expect(guardError.code).toBe(deployGuard.DEPLOY_GUARD_ERROR);
      expect(guardError.errors?.[0]).toContain("working tree is dirty");
    }
  });

  it("rejects untracked files as dirty (they compile into the bundle)", () => {
    expect.hasAssertions();
    try {
      deployGuard.assertDeployableGitState({
        statusOutput: "?? scratch.ts",
        headSha: CLEAN_SHA,
        currentBranch: "main",
        configuredBranch: "default",
      });
    } catch (error) {
      expect((error as Error).message).toContain("dirty");
    }
  });

  it("rejects unresolvable HEAD", () => {
    expect.hasAssertions();
    try {
      deployGuard.assertDeployableGitState({
        statusOutput: "",
        headSha: "",
        currentBranch: "main",
        configuredBranch: "default",
      });
    } catch (error) {
      expect((error as Error & { errors?: string[] }).errors?.[0]).toContain("HEAD cannot be resolved");
    }
  });

  it("rejects detached HEAD when branch=auto cannot map a target branch", () => {
    expect.hasAssertions();
    try {
      deployGuard.assertDeployableGitState({
        statusOutput: "",
        headSha: CLEAN_SHA,
        currentBranch: "",
        configuredBranch: "auto",
      });
    } catch (error) {
      expect((error as Error).message).toContain("detached HEAD or ambiguous branch");
    }
  });

  it("allows dirty tree only with the explicit development override", () => {
    const result = deployGuard.assertDeployableGitState({
      statusOutput: " M src/main.ts",
      headSha: CLEAN_SHA,
      currentBranch: "main",
      configuredBranch: "default",
      allowDirty: true,
    });
    expect(result.dirty).toBe(true);
  });
});

describe("computeModulesHash", () => {
  it("produces a stable hash for identical content regardless of key order", () => {
    const first = deployGuard.computeModulesHash({ main: "console.log(1);", extra: "x" });
    const second = deployGuard.computeModulesHash({ extra: "x", main: "console.log(1);" });
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches an independently computed sha256 over the same canonical form", () => {
    const expected = createHash("sha256")
      .update("main\0console.log(1);\0")
      .digest("hex");
    expect(deployGuard.computeModulesHash({ main: "console.log(1);" })).toBe(expected);
  });

  it("changes when module content changes", () => {
    const first = deployGuard.computeModulesHash({ main: "console.log(1);" });
    const second = deployGuard.computeModulesHash({ main: "console.log(2);" });
    expect(second).not.toBe(first);
  });

  it("distinguishes binary modules from string modules", () => {
    const asText = deployGuard.computeModulesHash({ m: "abc" });
    const asBinary = deployGuard.computeModulesHash({ m: { binary: "abc" } });
    expect(asBinary).not.toBe(asText);
  });
});

describe("diffRemoteModules", () => {
  const local = { main: "module.exports = 1;" };

  it("matches when remote is byte-identical", () => {
    const result = deployGuard.diffRemoteModules(local, { main: "module.exports = 1;" });
    expect(result.match).toBe(true);
    expect(result.remoteHash).toBe(result.localHash);
  });

  it("fails with changed detail when remote content differs", () => {
    const result = deployGuard.diffRemoteModules(local, { main: "module.exports = 2;" });
    expect(result.match).toBe(false);
    expect(result.changed).toEqual(["main"]);
    expect(result.missing).toEqual([]);
  });

  it("fails when modules are missing or extra on the remote", () => {
    const missing = deployGuard.diffRemoteModules({ a: "1", b: "2" }, { a: "1" });
    expect(missing.match).toBe(false);
    expect(missing.missing).toEqual(["b"]);

    const extra = deployGuard.diffRemoteModules(local, { main: "module.exports = 1;", stray: "x" });
    expect(extra.match).toBe(false);
    expect(extra.extra).toEqual(["stray"]);
  });

  it("fails safely when the remote response has no modules", () => {
    const result = deployGuard.diffRemoteModules(local, undefined);
    expect(result.match).toBe(false);
    expect(result.remoteHash).toBeNull();
  });
});
