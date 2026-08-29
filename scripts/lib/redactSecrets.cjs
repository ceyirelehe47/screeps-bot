// 统一脱敏纯函数库（安全 P0，2026-08-29）。
//
// 背景：Screeps API 的 429 错误响应体内嵌带 token 的
// /account/auth-tokens/noratelimit?token=... 链接，collector 曾把响应体
// 截断后原样写进采集日志（collect-canary3.log 泄露 token 前缀，历史已重写清除）。
// 本模块保证此后任何经由 collector 输出的错误/日志文本都不再包含凭据明文：
//   1. URL query 中的凭据参数（token=、key=、secret=、password= 等）；
//   2. Authorization / X-Token 头形式的凭据；
//   3. auth-tokens 链接路径（由规则 1 覆盖 query，另兜底裸 UUID 形态）；
//   4. 常见 secret/key JSON 字段的字符串值。
// 仅作用于"文本"，绝不接触真实请求头；纯函数，供 monitor-service.mjs
// （ESM named-import CJS）与 Jest 测试共用，惯例同 deployGuard.cjs。

const REDACTED = "<redacted>";

// query/头形式出现的凭据参数名（不含 remaining/retry 等普通参数）。
const CREDENTIAL_PARAM_NAMES =
  "token|apikey|api_key|secret|password|passwd|authorization|access_token|accesstoken|refresh_token|refreshtoken|client_secret|privatekey|private_key|sig|signature";

// 形如 `token=<值>`：值截止到 &、空白、引号、尖括号或行尾。
// 大小写不敏感；键名保留用于事后审计是哪类凭据被脱敏。
const QUERY_CREDENTIAL_PATTERN = new RegExp(
  `\\b(${CREDENTIAL_PARAM_NAMES})=([^&\\s"'<>\\\\]+)`,
  "gi",
);

// 形如 `Authorization: Bearer xxx` / `X-Token: xxx` 的头形式。
const HEADER_CREDENTIAL_PATTERN =
  /\b(Authorization|X-Token|Proxy-Authorization)\s*[:=]\s*[^\s"'<>]+/gi;

// JSON/对象 dump 形式：`"token": "value"`、`"apiKey":"value"`。
const JSON_CREDENTIAL_FIELD_PATTERN = new RegExp(
  `"(?:${CREDENTIAL_PARAM_NAMES})"\\s*:\\s*"[^"]*"`,
  "gi",
);

/** 对任意文本做统一脱敏；非字符串输入原样返回。 */
function redactSensitiveText(input) {
  if (typeof input !== "string" || input.length === 0) {
    return input;
  }
  return input
    .replace(QUERY_CREDENTIAL_PATTERN, `$1=${REDACTED}`)
    .replace(HEADER_CREDENTIAL_PATTERN, `$1: ${REDACTED}`)
    .replace(JSON_CREDENTIAL_FIELD_PATTERN, `"secret": "${REDACTED}"`);
}

/** 与 Error 构造等价的脱敏包装：返回 redact 后的 message 字符串。 */
function redactErrorMessage(error) {
  if (error === null || error === undefined) {
    return String(error);
  }
  const message =
    error instanceof Error ? error.message : typeof error === "object"
      ? safeStringify(error)
      : String(error);
  return redactSensitiveText(message);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = { REDACTED, redactSensitiveText, redactErrorMessage };
