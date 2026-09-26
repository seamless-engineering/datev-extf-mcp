#!/bin/sh
# Build datev-extf-mcp.mcpb: an MCP Bundle for one-click install in Claude
# Desktop and for directories that take bundles (e.g. Smithery's CLI).
set -eu
cd "$(dirname "$0")/.."
rm -rf build
mkdir -p build/mcpb
pnpm build
cp -r dist package.json manifest.json LICENSE README.md build/mcpb/
(cd build/mcpb && npm install --omit=dev --ignore-scripts --no-package-lock --no-audit --no-fund)
npx -y @anthropic-ai/mcpb@2.1.2 pack build/mcpb build/datev-extf-mcp.mcpb
