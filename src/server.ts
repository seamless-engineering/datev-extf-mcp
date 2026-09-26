/**
 * MCP server around @seamless-engineering/datev-extf. Everything runs on the
 * user's machine: files are read from disk by path, never uploaded.
 */

import { stat, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import {
  BUCHUNGSSTAPEL_COLUMNS,
  cleanBeleg1,
  DEBKRED_COLUMNS,
  decodeBytes,
  EXTF_AS_OF,
  encodeCp1252,
  type Finding,
  type FindingCode,
  fitsCp1252,
  formatFinding,
  type Lang,
  messages,
  type Report,
  validateExtf,
  writeBuchungsstapel,
} from "@seamless-engineering/datev-extf";
import * as z from "zod";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const DISCLAIMER =
  "Formatprüfung, keine Steuerberatung. / Format check, not tax advice. " +
  "DATEV is a trademark of DATEV eG; this tool is not affiliated with DATEV.";

/** DATEV caps a batch at 99,999 bookings; this leaves room for long rows. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Findings returned in full. The rest are only counted, so a broken export doesn't flood the context. */
const MAX_FINDINGS = 200;

const FINDING_CODES = Object.keys(messages.de) as [FindingCode, ...FindingCode[]];

const lang = z.enum(["de", "en"]).default("de").describe("Language of the messages: de (default) or en.");

const findingSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  line: z.number().optional(),
  field: z.number().optional(),
  fieldName: z.string().optional(),
  value: z.string().optional(),
  message: z.string(),
});

const reportSchema = z.object({
  category: z.string().optional().describe("buchungsstapel, debkred or other"),
  header: z.record(z.string(), z.unknown()).optional(),
  rows: z.number(),
  encoding: z.string(),
  errors: z.number(),
  warnings: z.number(),
  countsByCode: z.record(z.string(), z.number()),
  findings: z.array(findingSchema),
  truncated: z.boolean(),
  disclaimer: z.string(),
});

type ReportOutput = z.infer<typeof reportSchema>;

function summarize(report: Report, language: Lang): ReportOutput {
  const countsByCode: Record<string, number> = {};
  for (const f of report.findings) countsByCode[f.code] = (countsByCode[f.code] ?? 0) + 1;
  return {
    category: report.header?.category,
    header: report.header ? { ...report.header } : undefined,
    rows: report.rows,
    encoding: report.encoding,
    errors: report.findings.filter((f) => f.severity === "error").length,
    warnings: report.findings.filter((f) => f.severity === "warning").length,
    countsByCode,
    findings: report.findings.slice(0, MAX_FINDINGS).map((f: Finding) => ({
      code: f.code,
      severity: f.severity,
      line: f.line,
      field: f.field,
      fieldName: f.fieldName,
      value: f.value,
      message: formatFinding(f, language),
    })),
    truncated: report.findings.length > MAX_FINDINGS,
    disclaimer: DISCLAIMER,
  };
}

function reportText(out: ReportOutput): string {
  const head =
    out.errors + out.warnings === 0
      ? `No findings. ${out.rows} data rows, category ${out.category ?? "unknown"}, encoding ${out.encoding}.`
      : `${out.errors} errors, ${out.warnings} warnings in ${out.rows} data rows (category ${out.category ?? "unknown"}, encoding ${out.encoding}).`;
  const lines = out.findings.map((f) => `- ${f.severity}${f.line ? ` line ${f.line}` : ""} [${f.code}]: ${f.message}`);
  if (out.truncated) lines.push(`- ... only the first ${MAX_FINDINGS} findings are listed; countsByCode has the totals.`);
  return [head, ...lines, "", out.disclaimer].join("\n");
}

async function readExtfFile(path: string): Promise<Uint8Array> {
  const full = resolve(path);
  const info = await stat(full);
  if (!info.isFile()) throw new Error(`${full} is not a file.`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`${full} is ${info.size} bytes, more than the ${MAX_FILE_BYTES} this tool reads.`);
  return readFile(full);
}

const error = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

const numbered = (columns: readonly string[]) => columns.map((name, i) => `${i + 1}. ${name}`).join("\n");

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "datev-extf", title: "DATEV EXTF", version, websiteUrl: "https://seamless.engineering/tools/datev-extf-validator/" },
    {
      instructions:
        "Validates and writes DATEV-Format (EXTF) CSV files: Buchungsstapel and Debitoren/Kreditoren. " +
        "Use validate_datev_extf before a DATEV import or when an import fails, explain_datev_finding for a finding code, " +
        "write_buchungsstapel to create an importable booking batch. All processing is local. Results check the format, " +
        "not whether an account or tax key is right; that stays with the user's tax advisor.",
    },
  );

  server.registerTool(
    "validate_datev_extf",
    {
      title: "Validate a DATEV EXTF file",
      description:
        "Check a DATEV-Format (EXTF) CSV file, e.g. EXTF_Buchungsstapel.csv or a Debitoren/Kreditoren export, before importing it into DATEV " +
        "or after DATEV rejected it. Returns every problem with line, field and a plain-language explanation in German or English: " +
        "dot instead of comma in amounts, missing leading zeros in Belegdatum, BU-Schlüssel on automatic accounts, account length, " +
        "encoding, header errors and more. Pass a file path (preferred, the encoding is checked too) or the file content.",
      inputSchema: z.object({
        path: z.string().optional().describe("Path to the CSV file on this machine. Relative paths resolve against the server's working directory."),
        content: z.string().optional().describe("The file content as text, if there's no file. The encoding can't be checked this way."),
        lang,
      }),
      outputSchema: reportSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, content, lang: language }) => {
      if ((path === undefined) === (content === undefined)) return error("Pass either path or content, not both and not neither.");
      let decoded: ReturnType<typeof decodeBytes>;
      if (path !== undefined) {
        try {
          decoded = decodeBytes(await readExtfFile(path));
        } catch (e) {
          return error(`Can't read the file: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        // Pasted text is already decoded. Treat it as Windows-1252 so no encoding finding is raised for it.
        decoded = { text: content ?? "", encoding: "windows-1252", nonAscii: false };
      }
      const out = summarize(validateExtf(decoded), language);
      if (content !== undefined) out.encoding = "unknown (pasted text)";
      return { content: [{ type: "text", text: reportText(out) }], structuredContent: out };
    },
  );

  server.registerTool(
    "explain_datev_finding",
    {
      title: "Explain a DATEV EXTF finding code",
      description:
        "Explain what a validate_datev_extf finding code (e.g. amount-dot, bu-automatic, date-leading-zero) means and how to fix it. " +
        "Placeholders like {value} or {max} stand for values from the specific finding.",
      inputSchema: z.object({ code: z.enum(FINDING_CODES).describe("The finding code."), lang }),
      outputSchema: z.object({ code: z.string(), explanation: z.string(), disclaimer: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ code, lang: language }) => {
      const out = { code, explanation: messages[language][code], disclaimer: DISCLAIMER };
      return { content: [{ type: "text", text: `${code}: ${out.explanation}\n\n${DISCLAIMER}` }], structuredContent: out };
    },
  );

  const ymd = z.string().regex(/^20\d{6}$/, "YYYYMMDD");

  server.registerTool(
    "write_buchungsstapel",
    {
      title: "Write a DATEV Buchungsstapel",
      description:
        "Create a DATEV-Format Buchungsstapel (EXTF, Formatversion 13) from booking rows, ready for import into DATEV Rechnungswesen " +
        "or DATEV Unternehmen online. The result is checked with the validator before it's returned. With outputPath the file is " +
        "written as Windows-1252, the encoding DATEV expects; without it the CSV text is returned. " +
        "The tool formats bookings, it doesn't choose accounts or tax keys: take those from the user or their tax advisor.",
      inputSchema: z.object({
        header: z.object({
          berater: z.string().describe("Beraternummer, 4-7 digits"),
          mandant: z.string().describe("Mandantennummer, 1-5 digits"),
          wjStart: ymd.describe("Start of the fiscal year (WJ-Beginn), YYYYMMDD"),
          skl: z.number().int().min(4).max(8).describe("Sachkontenlänge, usually 4"),
          from: ymd.describe("First day of the batch period, YYYYMMDD"),
          to: ymd.describe("Last day of the batch period, YYYYMMDD, same calendar year as from"),
          label: z.string().describe("Batch label (Bezeichnung), at most 30 characters"),
          skr: z.enum(["03", "04", ""]).describe("Chart of accounts: 03, 04, or empty if unknown"),
        }),
        rows: z
          .array(
            z.object({
              amount: z.number().int().min(0).describe("Unsigned amount in cents, e.g. 11900 for 119,00"),
              side: z.enum(["S", "H"]).describe("S = Soll (debit on account), H = Haben (credit on account)"),
              account: z.string().describe("Konto"),
              contra: z.string().describe("Gegenkonto, without BU-Schlüssel"),
              key: z.string().optional().describe("BU-Schlüssel (tax key), if any"),
              day: z.number().int().min(1).max(31).describe("Belegdatum day"),
              month: z.number().int().min(1).max(12).describe("Belegdatum month"),
              beleg1: z.string().optional().describe("Belegfeld 1, e.g. the invoice number. Disallowed characters are removed, at most 36 kept."),
              text: z.string().optional().describe("Buchungstext, at most 60 characters"),
            }),
          )
          .min(1)
          .max(99999),
        outputPath: z.string().optional().describe("Where to write the file, e.g. EXTF_Buchungsstapel.csv. Existing files are overwritten."),
        lang,
      }),
      outputSchema: z.object({
        path: z.string().optional(),
        csv: z.string().optional(),
        rows: z.number(),
        changed: z.array(z.string()).describe("Belegfeld 1 values the writer had to clean, and texts with characters Windows-1252 can't hold"),
        report: reportSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ header, rows, outputPath, lang: language }) => {
      const csv = writeBuchungsstapel({ ...header, created: new Date() }, rows);
      const changed: string[] = [];
      rows.forEach((row, i) => {
        if (row.beleg1 !== undefined && cleanBeleg1(row.beleg1) !== row.beleg1)
          changed.push(`row ${i + 1}: Belegfeld 1 "${row.beleg1}" became "${cleanBeleg1(row.beleg1)}"`);
      });
      if (!fitsCp1252(csv)) changed.push("Some characters don't exist in Windows-1252 and are written as '?'.");
      const bytes = encodeCp1252(csv);
      const report = summarize(validateExtf(decodeBytes(bytes)), language);
      let path: string | undefined;
      if (outputPath !== undefined) {
        path = resolve(outputPath);
        try {
          await writeFile(path, bytes);
        } catch (e) {
          return error(`Can't write ${path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const out = { path, csv: path ? undefined : csv, rows: rows.length, changed, report };
      const text = [
        path ? `Wrote ${rows.length} bookings to ${path} (Windows-1252).` : `Buchungsstapel with ${rows.length} bookings:\n\n${csv}`,
        ...changed.map((c) => `- ${c}`),
        "",
        `Validator: ${reportText(report)}`,
      ].join("\n");
      return { content: [{ type: "text", text }], structuredContent: out };
    },
  );

  server.registerTool(
    "list_datev_columns",
    {
      title: "List DATEV EXTF columns",
      description:
        "List the columns (line 2) of a DATEV Buchungsstapel (Formatversion 13, 125 columns) or Debitoren/Kreditoren file (254 columns), " +
        "numbered by position. Use it to map export fields to DATEV columns or to find a column named in a finding.",
      inputSchema: z.object({ format: z.enum(["buchungsstapel", "debkred"]) }),
      outputSchema: z.object({ format: z.string(), columns: z.array(z.string()), asOf: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ format }) => {
      const columns = [...(format === "buchungsstapel" ? BUCHUNGSSTAPEL_COLUMNS : DEBKRED_COLUMNS)];
      return {
        content: [{ type: "text", text: `${numbered(columns)}\n\nAs of ${EXTF_AS_OF}.` }],
        structuredContent: { format, columns, asOf: EXTF_AS_OF },
      };
    },
  );

  const resources = [
    ["buchungsstapel-columns", "datev-extf://columns/buchungsstapel", "Buchungsstapel columns", () => numbered(BUCHUNGSSTAPEL_COLUMNS)],
    ["debkred-columns", "datev-extf://columns/debkred", "Debitoren/Kreditoren columns", () => numbered(DEBKRED_COLUMNS)],
    ...(["de", "en"] as const).map(
      (l) =>
        [
          `findings-${l}`,
          `datev-extf://findings/${l}`,
          `Finding codes and messages (${l})`,
          () => FINDING_CODES.map((code) => `${code}: ${messages[l][code]}`).join("\n"),
        ] as const,
    ),
  ] as const;
  for (const [name, uri, title, text] of resources) {
    server.registerResource(name, uri, { title, mimeType: "text/plain" }, (url) => ({
      contents: [{ uri: url.href, mimeType: "text/plain", text: text() }],
    }));
  }

  server.registerPrompt(
    "fix_datev_import",
    {
      title: "Fix a DATEV import",
      description: "Validate a DATEV EXTF file and propose fixes for what DATEV would reject.",
      argsSchema: z.object({ path: z.string().describe("Path to the EXTF CSV file") }),
    },
    ({ path }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Run validate_datev_extf on ${path}. Group the findings by code, explain each group in one or two sentences, ` +
              "and propose a concrete fix for the export that produced the file (not just for this one file). Errors first, then warnings. " +
              "Don't judge whether accounts or tax keys are right for the business: that's a question for the tax advisor.",
          },
        },
      ],
    }),
  );

  return server;
}
