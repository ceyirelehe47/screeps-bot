/**
 * Treasury resolution kernel 通道（第十一轮 3.13.8）。
 *
 * 生产 TreasuryService 类型与运行时对象都不暴露 resolution 内部原语
 * （capability consume/validate）。resolution kernel 以本模块导出的
 * unique symbol 作为 non-enumerable 属性挂载在 service 运行时对象上，
 * 仅供：
 *
 * - faultResolution 的两个 resolve 函数（经 kernel 消费/验证 capability
 *   ——模块级注册函数已删除，closure 直接调用）；
 * - test harness（testHarness.ts 展开为测试视图）。
 *
 * 架构测试全量扫描生产源码：resolutionKernelChannel 的 import 白名单仅
 * facade/faultResolution/testHarness——其它模块引用即违规。
 */

import type { TreasuryReconciliationCapabilityConsumption } from "@/runtime/treasury/reconciliation";

/** resolution kernel 唯一通道键（运行时 non-enumerable 挂载）。 */
export const TREASURY_RESOLUTION_KERNEL: unique symbol = Symbol("treasury.resolution-kernel");

/** resolution kernel 内部接口（service closure 实现，普通调用者不可取得）。 */
export interface TreasuryResolutionKernel {
  /** 只读验证（对象身份/单次未用/generation/tick——零消费）。 */
  validateReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption;
  /** 校验并消费（单次使用语义；仅 staged resolution 写入成功后调用）。 */
  consumeReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption;
}

/** 持有 resolution kernel 的运行时对象形态（faultResolution 内部 cast 用）。 */
export interface TreasuryResolutionKernelHolder {
  readonly [TREASURY_RESOLUTION_KERNEL]: TreasuryResolutionKernel;
}
