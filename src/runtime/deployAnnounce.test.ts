/**
 * 部署身份宣告测试（阶段 B）：
 * - bundle 首个 tick 写入完整身份（tag/commit/tree/bundleHash/branch/at）；
 * - 同一 build（tag+bundleHash 均相同）不重复更新；
 * - tag 相同但 bundle 内容指纹不同（标签与内容失真的核心场景）必须更新；
 * - BUILD_INFO 兜底字段完整（构建常量未注入时仍可运行）。
 */
import { announceDeploy } from "@/runtime/deployAnnounce";
import { BUILD_INFO } from "@/buildMeta";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };

describe("announceDeploy", () => {
  beforeEach(() => {
    delete (global as RuntimeGlobal).__runtimeServices;
    Memory.runtime = undefined;
    Game.time += 1;
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    (console.log as jest.Mock).mockRestore();
  });

  it("writes the full deploy identity on the first tick of a new bundle", () => {
    announceDeploy();

    expect(Memory.runtime?.lastDeployTag).toBe(BUILD_INFO.tag);
    expect(Memory.runtime?.lastDeployCommit).toBe(BUILD_INFO.commit);
    expect(Memory.runtime?.lastDeployTree).toBe(BUILD_INFO.tree);
    expect(Memory.runtime?.lastDeployBundleHash).toBe(BUILD_INFO.bundleHash);
    expect(Memory.runtime?.lastDeployBranch).toBe(BUILD_INFO.deployBranch);
    expect(Memory.runtime?.lastDeployAt).toBe(Game.time);
  });

  it("does not rewrite identity when neither tag nor bundle hash changed", () => {
    announceDeploy();
    const firstAt = Memory.runtime?.lastDeployAt;

    Game.time += 100;
    announceDeploy();

    expect(Memory.runtime?.lastDeployAt).toBe(firstAt);
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it("updates identity when the tag matches but the bundle content hash differs", () => {
    announceDeploy();

    // 标签相同、内容不同：正是 2026-08-24 失真场景的运行时检测面。
    const holder = globalThis as { __DEPLOY_BUNDLE_HASH__?: string };
    holder.__DEPLOY_BUNDLE_HASH__ = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    try {
      Game.time += 1;
      announceDeploy();

      expect(Memory.runtime?.lastDeployBundleHash).toBe(holder.__DEPLOY_BUNDLE_HASH__);
      expect(Memory.runtime?.lastDeployAt).toBe(Game.time);
    } finally {
      delete holder.__DEPLOY_BUNDLE_HASH__;
    }
  });

  it("keeps BUILD_INFO complete with fallbacks when build constants are absent", () => {
    // ts-jest 环境不注入 __BUILD_*__ 常量，走 dev 兜底路径；字段必须齐备。
    expect(typeof BUILD_INFO.version).toBe("string");
    expect(typeof BUILD_INFO.gitHash).toBe("string");
    expect(typeof BUILD_INFO.commit).toBe("string");
    expect(typeof BUILD_INFO.tree).toBe("string");
    expect(typeof BUILD_INFO.branch).toBe("string");
    expect(typeof BUILD_INFO.deployBranch).toBe("string");
    expect(typeof BUILD_INFO.dirty).toBe("boolean");
    expect(typeof BUILD_INFO.bundleHash).toBe("string");
  });
});
