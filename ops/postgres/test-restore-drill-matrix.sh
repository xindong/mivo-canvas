#!/usr/bin/env bash
# ops/postgres/test-restore-drill-matrix.sh — R2-2 对抗矩阵单测(无 docker/PG)。
# source asset-verify.sh,测 manifest 解析状态 + ALLOW_EMPTY 矩阵 + dump-consistent 行计数。
# 覆盖验收矩阵:allow0/allow1 × 全缺/部分缺/全在 × manifest valid/malformed/no-jq + count_copy_rows 纯函数。
# 成功标准:全 PASS,FAIL=0;该 fail 却 exit 0 / 该 ok 却 exit 1 → 非 0 退出。
# 跑法:bash ops/postgres/test-restore-drill-matrix.sh
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # 动态路径;已显式 source
. "$dir/asset-verify.sh"

PASS=0; FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 断言 helper:实际 == 期望 → ok,否则 bad。
expect() { local desc="$1" actual="$2" expected="$3"; if [ "$actual" = "$expected" ]; then ok "$desc (=$actual)"; else bad "$desc: 期望=$expected 实际=$actual"; fi; }

echo "=== R2-2 decide_core_missing 矩阵(allow0/1 × missing 0/1/2/3 × preSchema) ==="

# 全在(0 缺失):无论 allow/preSchema → pass
expect "missing=0 allow=0 → pass" "$(decide_core_missing 0 0 '')" pass
expect "missing=0 allow=1 preSchema=true → pass" "$(decide_core_missing 0 1 true)" pass
expect "missing=0 allow=0 preSchema=true → pass" "$(decide_core_missing 0 0 true)" pass

# allow=0(生产禁用 ALLOW_EMPTY):任何缺失 → fail
expect "missing=1 allow=0 → fail" "$(decide_core_missing 1 0 '')" fail
expect "missing=2 allow=0 → fail" "$(decide_core_missing 2 0 '')" fail
expect "missing=3 allow=0 preSchema=true → fail(allow=0 不放行,生产禁用)" "$(decide_core_missing 3 0 true)" fail

# allow=1:只许三核心表全缺(3)+ manifest 明示 pre-schema(true);否则 fail
expect "missing=3 allow=1 preSchema=true → warn(legit pre-schema)" "$(decide_core_missing 3 1 true)" warn
expect "missing=3 allow=1 preSchema='' → fail(全缺但未声明 pre-schema)" "$(decide_core_missing 3 1 '')" fail
expect "missing=3 allow=1 preSchema=false → fail(preSchema=false 非真)" "$(decide_core_missing 3 1 false)" fail
expect "missing=1 allow=1 preSchema=true → fail(部分缺,即使声明 pre-schema也不放行)" "$(decide_core_missing 1 1 true)" fail
expect "missing=2 allow=1 preSchema=true → fail(部分缺)" "$(decide_core_missing 2 1 true)" fail

echo "=== R2-2 manifest_parse_status(absent / present / malformed / no-jq) ==="

# absent:无文件
absent_manifest="$WORK/absent.manifest.json"
expect "absent manifest → absent" "$(manifest_parse_status "$absent_manifest")" absent
expect "empty path → absent" "$(manifest_parse_status '')" absent

# present:合法 JSON
present_manifest="$WORK/present.manifest.json"
printf '{"preSchema":true,"tables":{"persist_records":5,"projects":1,"canvases":2},"assetBlobCount":3}' > "$present_manifest"
expect "valid JSON manifest → present" "$(manifest_parse_status "$present_manifest")" present

# malformed:坏 JSON
malformed_manifest="$WORK/malformed.manifest.json"
printf '{this is not json,,,missing quotes}' > "$malformed_manifest"
expect "malformed JSON → malformed(hard fail 信号)" "$(manifest_parse_status "$malformed_manifest")" malformed

# manifest_field 在 present 时返字段值;malformed 时返 -1(跳过——但 restore-drill 已据 malformed hard fail)
expect "present manifest .preSchema → true" "$(manifest_field "$present_manifest" '.preSchema')" true
expect "present manifest .tables.persist_records → 5" "$(manifest_field "$present_manifest" '.tables.persist_records')" 5
expect "present manifest 缺字段 → -1" "$(manifest_field "$present_manifest" '.nonexistent')" -1
expect "absent manifest field → -1" "$(manifest_field "$absent_manifest" '.preSchema')" -1

# no-jq:PATH 屏蔽 jq → manifest 存在但无法解析 → no-jq(hard fail 信号,不假绿跳过)
if command -v jq >/dev/null 2>&1; then
  # 用一个不含 jq 的 PATH 跑 manifest_parse_status,模拟无 jq 环境。
  no_jq_dir="$(mktemp -d)"
  expect "no-jq 环境 + present manifest → no-jq(hard fail)" "$(PATH="$no_jq_dir" manifest_parse_status "$present_manifest")" no-jq
  expect "no-jq 环境 + malformed manifest → no-jq(无法判定,hard fail)" "$(PATH="$no_jq_dir" manifest_parse_status "$malformed_manifest")" no-jq
  rm -rf "$no_jq_dir"
else
  ok "jq 不在本机,manifest_parse_status 无-jq 路径已由 absent/malformed 覆盖(跳过 no-jq 专项)"
fi

echo "=== R2-2 count_copy_rows(dump-consistent 行计数纯函数) ==="

# 3 行数据 → 3
block3='COPY public.persist_records (id, owner_id) FROM stdin;
r1aaa
r2bbb
r3ccc
\.'
expect "COPY 块 3 行 → 3" "$(printf '%s\n' "$block3" | count_copy_rows)" 3

# 空 COPY(表存在 0 行)→ 0
block0='COPY public.projects (id) FROM stdin;
\.'
expect "COPY 块 0 行 → 0" "$(printf '%s\n' "$block0" | count_copy_rows)" 0

# 无 COPY 块(表在 dump TOC 缺)→ 0
expect "无 COPY 块 → 0" "$(printf 'no copy block here\njust noise\n' | count_copy_rows)" 0

# 多个 COPY 块(不该发生在 --table 单表提取,但 awk 容错:只计 COPY 与 \. 间)→ 计所有块
block2x='COPY public.t1 (id) FROM stdin;
a
\.
COPY public.t2 (id) FROM stdin;
b
c
\.'
expect "两 COPY 块共 3 行 → 3" "$(printf '%s\n' "$block2x" | count_copy_rows)" 3

# 数据行含 `\.` 子串(非结束符,只有单独一行 ^\. 才结束)→ 不误判结束
block_tricky='COPY public.t (id) FROM stdin;
has\.dot
second
\.'
expect "数据含\\. 子串不误结束 → 2" "$(printf '%s\n' "$block_tricky" | count_copy_rows)" 2

echo "----------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
