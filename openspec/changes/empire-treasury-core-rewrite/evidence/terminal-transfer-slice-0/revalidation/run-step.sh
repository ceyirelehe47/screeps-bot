#!/usr/bin/env bash
# 复验步骤统一执行器：保存 .command.txt / .log / .exit-code.txt 到输出目录。
# 用法: run-step.sh <name> <workdir> <command...>   （环境变量请用 env VAR=... 形式传入）
set -u
name="$1"; shift
workdir="$1"; shift
OUT="C:/Users/15027/AppData/Local/Temp/slice0-review/output"
{
  printf 'cd %s\n' "$workdir"
  printf '%q ' "$@"
  printf '\n'
} > "$OUT/$name.command.txt"
set +e
(
  cd "$workdir" || { printf '99\n' > "$OUT/$name.exit-code.txt"; exit 99; }
  "$@" > "$OUT/$name.log" 2>&1
  rc=$?
  printf '%s\n' "$rc" > "$OUT/$name.exit-code.txt"
  exit "$rc"
)
rc=$?
set -e 2>/dev/null || true
printf '[%s] exit=%s\n' "$name" "$rc"
exit "$rc"
