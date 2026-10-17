import { utf8ByteLength } from "@/util/utf8";

it.each(["ASCII", "中文", "🚀", "a\uD800b", "\uDC00", "\uD800\uD800\uDC00"])("UTF-8 尺寸与实际编码一致：%s", value => {
  expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value, "utf8"));
});
