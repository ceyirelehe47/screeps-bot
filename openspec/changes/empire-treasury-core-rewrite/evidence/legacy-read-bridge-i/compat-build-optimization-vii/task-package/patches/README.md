补丁由 Git 从固定 cdecde 源切片与交付 payload 生成。只用于独立复现和审查；正常执行使用 tools/run.cjs apply，不要两次应用。新11路径必须逐字节匹配 source-lock.json。
