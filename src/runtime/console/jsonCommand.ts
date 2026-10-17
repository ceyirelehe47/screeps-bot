/** 纯输出包装：保留 Raw 的参数、异常与字符串错误，不执行额外业务操作。 */
export function formatConsoleResult(value: unknown, space?: number): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, space);
}

export function jsonCommand<Args extends unknown[]>(
  raw: (...args: Args) => unknown,
  space?: number,
  passthroughStrings = false,
): (...args: Args) => string {
  return (...args: Args) => {
    const result = raw(...args);
    return passthroughStrings ? formatConsoleResult(result, space) : JSON.stringify(result, null, space);
  };
}
