const { pathsToModuleNameMapper } = require("ts-jest");
const { compilerOptions } = require("./tsconfig.json");

module.exports = {
  preset: "ts-jest",
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
