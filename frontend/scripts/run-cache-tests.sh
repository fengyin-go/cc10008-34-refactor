#!/usr/bin/env bash
# 缓存子系统测试：用仓库已有的 esbuild 把 TS 测试打包到临时目录，再交给 Node 内置测试运行器。
# 不引入新依赖；产物放在 .cache-test-build，结束后清理。
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_DIR=".cache-test-build"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

ENTRY="$BUILD_DIR/run-cache-tests.mjs"

# 测试入口：显式导入三个测试文件，node:test 自动收集并执行。
printf '%s\n' "import '../tests/cache/versioned-cache.test.ts'" > "$ENTRY.tmp"
printf '%s\n' "import '../tests/cache/persistence.test.ts'" >> "$ENTRY.tmp"
printf '%s\n' "import '../tests/cache/cache-service.test.ts'" >> "$ENTRY.tmp"
mv "$ENTRY.tmp" "$ENTRY"

./node_modules/.bin/esbuild "$ENTRY" \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node20 \
  --outfile="$BUILD_DIR/bundle.mjs" \
  --log-level=warning

node --test "$BUILD_DIR/bundle.mjs"
status=$?

rm -rf "$BUILD_DIR"
exit "$status"
