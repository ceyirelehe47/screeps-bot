import { BUILD_INFO } from "@/buildMeta";
import { getMemoryService } from "@/runtime/runtimeServices";

/**
 * 部署身份宣告：bundle 首个 tick 把构建身份写入 Memory.runtime。
 *
 * 更新判定是 tag + bundle 内容指纹双条件——只比 tag 会被"标签与内容失真"
 * 欺骗（2026-08-24 事件：tag 标注 HEAD 引用 907f837，实际内容是未提交的
 * 6fc4bf2）；bundleHash 不同的构建即使 tag 相同也会被识别并覆盖。
 * 旧字段 lastDeployTag 保留（monitor 依赖），新字段增量写入。
 */
export function announceDeploy(): void {
  const runtime = getMemoryService().ensureRuntime();
  if (runtime.lastDeployTag === BUILD_INFO.tag && runtime.lastDeployBundleHash === BUILD_INFO.bundleHash) {
    return;
  }

  runtime.lastDeployTag = BUILD_INFO.tag;
  runtime.lastDeployCommit = BUILD_INFO.commit;
  runtime.lastDeployTree = BUILD_INFO.tree;
  runtime.lastDeployBundleHash = BUILD_INFO.bundleHash;
  runtime.lastDeployBranch = BUILD_INFO.deployBranch;
  runtime.lastDeployAt = Game.time;
  console.log(`[deploy] ${BUILD_INFO.tag}`);
}
