#!/bin/bash
set -e
pnpm install
pnpm --filter db push

# Gate merges on a full workspace typecheck: rebuild lib project references
# (tsc -b) so stale lib/db/dist can't mask schema changes, then typecheck
# every workspace package and verify the api-server esbuild build.
pnpm run typecheck
pnpm --filter @workspace/api-server run build
