const BUILD_VERSION = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "dev";
const BUILD_GIT_HASH = typeof __BUILD_GIT_HASH__ !== "undefined" ? __BUILD_GIT_HASH__ : "nogit";
const BUILD_TIME = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "1970-01-01T00:00:00.000Z";
const BUILD_TAG = typeof __BUILD_TAG__ !== "undefined" ? __BUILD_TAG__ : `${BUILD_VERSION}+${BUILD_GIT_HASH}@${BUILD_TIME}`;
const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : "nogit";
const BUILD_TREE = typeof __BUILD_TREE__ !== "undefined" ? __BUILD_TREE__ : "nogit";
const BUILD_BRANCH = typeof __BUILD_BRANCH__ !== "undefined" ? __BUILD_BRANCH__ : "detached";
const BUILD_DIRTY = typeof __BUILD_DIRTY__ !== "undefined" ? __BUILD_DIRTY__ : "false";
const BUILD_DEPLOY_BRANCH = typeof __BUILD_DEPLOY_BRANCH__ !== "undefined" ? __BUILD_DEPLOY_BRANCH__ : "unknown";

// bundle 内容指纹由 rollup 在产物末尾追加的全局赋值注入（append 前内容的
// SHA-256）。使用 getter：bundle 模块加载完成后该全局才存在，而 BUILD_INFO
// 的其余字段在模块初始化时即可用；announceDeploy 在首个 tick 读取，时序安全。
// 全局访问经由审计的 global root（与 movement metrics 相同模式）。
type RuntimeGlobalWithDeployBundleHash = typeof global & {
  __DEPLOY_BUNDLE_HASH__?: string;
};
const runtimeGlobal: RuntimeGlobalWithDeployBundleHash = global;

function readDeployBundleHash(): string {
  return runtimeGlobal.__DEPLOY_BUNDLE_HASH__ ?? "none";
}

export const BUILD_INFO = {
  version: BUILD_VERSION,
  gitHash: BUILD_GIT_HASH,
  buildTime: BUILD_TIME,
  tag: BUILD_TAG,
  commit: BUILD_COMMIT,
  tree: BUILD_TREE,
  branch: BUILD_BRANCH,
  dirty: BUILD_DIRTY === "true",
  deployBranch: BUILD_DEPLOY_BRANCH,
  get bundleHash(): string {
    return readDeployBundleHash();
  },
} as const;
