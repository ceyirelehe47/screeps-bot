/**
 * 统一脱敏纯函数测试（安全 P0，2026-08-29）。
 *
 * 背景：Screeps 429 响应体内的 noratelimit 链接（?token=...）曾随错误消息
 * 进入采集日志。此处锁定 redactSecrets.cjs 的行为契约：所有凭据形态
 * （URL query、Authorization/X-Token 头、JSON 字段）一律替换为 <redacted>，
 * 普通参数与文本不受影响，且脱敏幂等。
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

interface RedactSecretsModule {
  REDACTED: string;
  redactSensitiveText(input: string): string;
  redactErrorMessage(error: unknown): string;
}

// .cjs 经 require 装载（同 deployGuard.test.ts 惯例）。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const redactSecrets = require("./redactSecrets.cjs") as RedactSecretsModule;

const REPO_ROOT = resolve(__dirname, "..", "..");
const FAKE_TOKEN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("redactSecrets 统一脱敏", () => {
  test("URL query 中的 token 被脱敏（429 noratelimit 真实形态）", () => {
    const line = `HTTP 429 for /api/user/memory: {"error":"Rate limit exceeded, retry after 36531905ms or disable rate limiting using this link: https://screeps.com/a/#!/account/auth-tokens/noratelimit?token=${FAKE_TOKEN}"} | remaining=0`;
    const redacted = redactSecrets.redactSensitiveText(line);
    expect(redacted).not.toContain(FAKE_TOKEN);
    expect(redacted).toContain("noratelimit?token=<redacted>");
    // 非凭据信息保留，供事后审计。
    expect(redacted).toContain("HTTP 429 for /api/user/memory");
    expect(redacted).toContain("remaining=0");
  });

  test("多个 query 参数只脱凭据键，普通参数保留", () => {
    const redacted = redactSecrets.redactSensitiveText(
      "https://example.test/api?path=cfg&shard=shard1&token=abc123&limit=10",
    );
    expect(redacted).toBe(
      "https://example.test/api?path=cfg&shard=shard1&token=<redacted>&limit=10",
    );
  });

  test("Authorization / X-Token 头形式被脱敏", () => {
    expect(
      redactSecrets.redactSensitiveText(
        `Authorization: Bearer ${FAKE_TOKEN} sent`,
      ),
    ).toBe("Authorization: <redacted> sent");
    expect(
      redactSecrets.redactSensitiveText(`X-Token: ${FAKE_TOKEN}`),
    ).toBe("X-Token: <redacted>");
  });

  test("常见 secret/key JSON 字段的值被脱敏", () => {
    const dump = `{"token":"${FAKE_TOKEN}","apiKey":"k1","password":"p1","mode":"direct"}`;
    const redacted = redactSecrets.redactSensitiveText(dump);
    expect(redacted).not.toContain(FAKE_TOKEN);
    expect(redacted).not.toContain('"k1"');
    expect(redacted).not.toContain('"p1"');
    expect(redacted).toContain('"mode":"direct"');
  });

  test("脱敏幂等：已脱敏文本重复处理不变化", () => {
    const once = redactSecrets.redactSensitiveText(
      `?token=${FAKE_TOKEN} Authorization: Bearer ${FAKE_TOKEN}`,
    );
    expect(redactSecrets.redactSensitiveText(once)).toBe(once);
  });

  test("redactErrorMessage 覆盖 Error / 对象 / 空值输入", () => {
    expect(
      redactSecrets.redactErrorMessage(new Error(`boom ?token=${FAKE_TOKEN}`)),
    ).not.toContain(FAKE_TOKEN);
    expect(
      redactSecrets.redactErrorMessage({ token: FAKE_TOKEN }),
    ).not.toContain(FAKE_TOKEN);
    expect(redactSecrets.redactErrorMessage(null)).toBe("null");
    expect(redactSecrets.redactErrorMessage(undefined)).toBe("undefined");
  });

  test("monitor-service.mjs 已接线：fetchApiJson 错误消息不再携带 token", () => {
    // 静态契约：collector 源码必须 import 脱敏库并在错误路径使用。
    const source = execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(require('fs').readFileSync('scripts/monitor-service.mjs','utf8'))"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(source).toContain('from "./lib/redactSecrets.cjs"');
    expect(source).toContain("redactErrorMessage(");
    expect(source).toContain("redactSensitiveText(");
  });
});
