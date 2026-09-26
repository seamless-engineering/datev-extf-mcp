import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { decodeBytes, validateExtf } from "@seamless-engineering/datev-extf";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer, DISCLAIMER } from "../src/server.js";

const header = {
  berater: "29098",
  mandant: "55003",
  wjStart: "20260101",
  skl: 4,
  from: "20260601",
  to: "20260630",
  label: "Shop 06/2026",
  skr: "03",
};

const rows = [
  { amount: 11900, side: "S", account: "1360", contra: "8400", day: 2, month: 6, beleg1: "RE2026-114", text: "Bestellung 114" },
  { amount: 2900, side: "H", account: "1360", contra: "4970", day: 30, month: 6, beleg1: "GEB 2026_06", text: "Gebühren Juni" },
];

let client: Client;
let dir: string;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  dir = await mkdtemp(join(tmpdir(), "datev-extf-mcp-"));
});

type Out = Record<string, unknown> & { report?: Record<string, unknown> };
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  return { result, out: result.structuredContent as Out };
};

describe("datev-extf MCP server", () => {
  it("lists the four tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "explain_datev_finding",
      "list_datev_columns",
      "validate_datev_extf",
      "write_buchungsstapel",
    ]);
  });

  it("writes a Buchungsstapel that DATEV's rules accept, as Windows-1252", async () => {
    const path = join(dir, "EXTF_Buchungsstapel.csv");
    const { out } = await call("write_buchungsstapel", { header, rows, outputPath: path });
    expect(out.path).toBe(path);
    expect(out.report?.errors).toBe(0);
    expect(out.changed).toEqual(['row 2: Belegfeld 1 "GEB 2026_06" became "GEB202606"']);
    const bytes = await readFile(path);
    expect(bytes.includes(0xfc)).toBe(true); // "ü" in Windows-1252
    expect(validateExtf(decodeBytes(bytes)).findings).toEqual([]);
  });

  it("finds the mistakes in a file on disk, encoding included, in German by default", async () => {
    const { out: written } = await call("write_buchungsstapel", { header, rows });
    const broken = String(written.csv).replace("119,00", "119.00");
    const path = join(dir, "broken.csv");
    await writeFile(path, broken); // UTF-8 without BOM, with an "ü" in it
    const { result, out } = await call("validate_datev_extf", { path });
    expect(out.errors).toBe(1);
    expect(out.countsByCode).toEqual({ "utf8-without-bom": 1, "amount-dot": 1 });
    expect(out.findings).toMatchObject([
      { code: "utf8-without-bom", severity: "warning" },
      { code: "amount-dot", line: 3, severity: "error" },
    ]);
    expect(out.disclaimer).toBe(DISCLAIMER);
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain("Komma");
    expect(text).toContain("keine Steuerberatung");
  });

  it("validates pasted content in English", async () => {
    const { out } = await call("validate_datev_extf", { content: "foo;bar", lang: "en" });
    expect(out.encoding).toBe("unknown (pasted text)");
    expect((out.findings as { message: string }[])[0].message).toMatch(/[A-Za-z]/);
  });

  it("rejects both or neither of path and content, and missing files", async () => {
    expect((await call("validate_datev_extf", {})).result.isError).toBe(true);
    expect((await call("validate_datev_extf", { path: "a", content: "b" })).result.isError).toBe(true);
    const missing = await call("validate_datev_extf", { path: join(dir, "nope.csv") });
    expect(missing.result.isError).toBe(true);
  });

  it("explains a finding code", async () => {
    const { out } = await call("explain_datev_finding", { code: "amount-dot", lang: "en" });
    expect(out.explanation).toContain("comma");
  });

  it("lists columns and serves them as resources", async () => {
    const { out } = await call("list_datev_columns", { format: "buchungsstapel" });
    expect(out.columns).toHaveLength(125);
    const { contents } = await client.readResource({ uri: "datev-extf://columns/debkred" });
    expect((contents[0] as { text: string }).text.split("\n")).toHaveLength(254);
    const findings = await client.readResource({ uri: "datev-extf://findings/en" });
    expect((findings.contents[0] as { text: string }).text).toContain("amount-dot:");
  });

  it("offers the fix_datev_import prompt", async () => {
    const prompt = await client.getPrompt({ name: "fix_datev_import", arguments: { path: "x.csv" } });
    expect(JSON.stringify(prompt.messages)).toContain("validate_datev_extf on x.csv");
  });
});
