import { priceToMilliDown, priceToMilliUp } from "@/runtime/marketSalePricing";

export interface NetDealQuote {
  grossPriceMilli: number;
  netCreditsMilli: number;
  floorMilli: number;
}

/** 保留逐项 milli 舍入与 1 单位最坏成交检查，避免小额成交把运费吃成亏损。 */
export function quoteNetDeal(
  price: number, amount: number, fee: number, worstFee: number,
  energyPrice: number, floor: number, minNotional: number,
): NetDealQuote | undefined {
  if (![price, energyPrice, floor, minNotional].every(Number.isFinite) || price <= 0 || energyPrice < 0 || floor <= 0 || minNotional < 0 ||
      ![amount, fee, worstFee].every(value => Number.isSafeInteger(value) && value >= 0) || amount < 1) return undefined;
  try {
    const grossPriceMilli = priceToMilliDown(price);
    const energyMilli = energyPrice === 0 ? 0 : priceToMilliUp(energyPrice);
    const floorMilli = priceToMilliUp(floor);
    const gross = grossPriceMilli * amount;
    const feeCost = fee * energyMilli;
    const worstCost = worstFee * energyMilli;
    const required = floorMilli * amount;
    const netCreditsMilli = gross - feeCost;
    if (![gross, feeCost, worstCost, required, netCreditsMilli].every(Number.isSafeInteger)) return undefined;
    if (gross < priceToMilliUp(minNotional) || netCreditsMilli < required || grossPriceMilli - worstCost < floorMilli) return undefined;
    return { grossPriceMilli, netCreditsMilli, floorMilli };
  } catch { return undefined; }
}

/** 连分数比较，避免安全整数净额与数量交叉相乘溢出。 */
export function compareNetUnitPrice(leftN: number, leftD: number, rightN: number, rightD: number): number {
  if (![leftN, rightN].every(value => Number.isSafeInteger(value) && value >= 0) ||
      ![leftD, rightD].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError("invalid net price ratio");
  let sign = 1;
  while (true) {
    const leftWhole = Math.floor(leftN / leftD), rightWhole = Math.floor(rightN / rightD);
    if (leftWhole !== rightWhole) return (leftWhole < rightWhole ? -1 : 1) * sign;
    const leftRest = leftN - leftWhole * leftD, rightRest = rightN - rightWhole * rightD;
    if (leftRest === 0 || rightRest === 0) return leftRest === rightRest ? 0 : (leftRest === 0 ? -1 : 1) * sign;
    leftN = leftD; leftD = leftRest; rightN = rightD; rightD = rightRest; sign *= -1;
  }
}
