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

# Smithery's CLI turns manifest.tools into its server card and wants each
# tool's inputSchema, which the MCPB manifest schema doesn't allow. So it gets
# its own bundle with the tools as the server lists them. Publish with:
#   SMITHERY_API_KEY=... npx @smithery/cli mcp publish build/datev-extf-smithery.mcpb -n seamless-engineering/datev-extf
rm -rf build/smithery
cp -r build/mcpb build/smithery
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "./dist/server.js";
const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(b);
const client = new Client({ name: "bundle", version: "0" });
await client.connect(a);
const { tools } = await client.listTools();
const manifest = JSON.parse(readFileSync("build/smithery/manifest.json", "utf8"));
delete manifest.tools_generated;
manifest.tools = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
writeFileSync("build/smithery/manifest.json", JSON.stringify(manifest, null, 2));
await client.close();
'
(cd build/smithery && rm -f ../datev-extf-smithery.mcpb && zip -qr ../datev-extf-smithery.mcpb .)
