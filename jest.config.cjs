const { pathsToModuleNameMapper } = require("ts-jest");
const { compilerOptions } = require("./tsconfig.json");

module.exports = {
  preset: "ts-jest",
  // 服务器隔离目录可接管缓存，避免共享 /tmp 的容量影响验证结果。
  ...(process.env.SCREEPS_JEST_CACHE_DIR ? { cacheDirectory: process.env.SCREEPS_JEST_CACHE_DIR } : {}),
  roots: ["<rootDir>"],
  // 类型检查由 npm run typecheck 独立执行；限制并行 worker 与常驻内存。
  maxWorkers: 2,
  workerIdleMemoryLimit: "512MB",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { isolatedModules: true } }],
  },
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths || {}, {
    prefix: "<rootDir>/",
  }),
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
};
