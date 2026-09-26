# datev-extf-mcp

[![npm](https://img.shields.io/npm/v/@seamless-engineering/datev-extf-mcp)](https://www.npmjs.com/package/@seamless-engineering/datev-extf-mcp)
[![CI](https://github.com/seamless-engineering/datev-extf-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/seamless-engineering/datev-extf-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

MCP server that validates and writes **DATEV-Format (EXTF)** files: Buchungsstapel (booking batches) and Debitoren/Kreditoren (customer and supplier master data). Ask your AI assistant why DATEV rejected an import, or have it turn a list of bookings into a file DATEV accepts.

*Deutsch:* MCP-Server, der Dateien im DATEV-Format (EXTF) prüft und schreibt. Fragen Sie Ihren KI-Assistenten, warum DATEV einen Import ablehnt: Er bekommt jeden Fehler mit Zeile, Feld und einer verständlichen Erklärung, etwa Punkt statt Komma im Umsatz, fehlende führende Null im Belegdatum oder BU-Schlüssel auf Automatikkonten.

- **Local only.** The server runs on your machine and reads files from disk. Nothing is uploaded, and there's no account or API key.
- Built on [`@seamless-engineering/datev-extf`](https://github.com/seamless-engineering/datev-extf). Its rules come from DATEV's own material: the Formatbeschreibung on developer.datev.de, the DATEV-Format Prüfprogramm and the `#REW` import messages.
- Every file the writer produces passes the validator.

Prefer a browser? The same checks run in the [DATEV EXTF validator](https://seamless.engineering/de/tools/datev-extf-validator/) ([English](https://seamless.engineering/tools/datev-extf-validator/)), also without upload.

## Install

Needs Node.js 20 or later.

**Claude Code**

```sh
claude mcp add datev-extf -- npx -y @seamless-engineering/datev-extf-mcp
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`) and most other clients:

```json
{
  "mcpServers": {
    "datev-extf": {
      "command": "npx",
      "args": ["-y", "@seamless-engineering/datev-extf-mcp"]
    }
  }
}
```

Relative file paths resolve against the server's working directory, so absolute paths are the safer choice.

## Tools

| Tool | What it does |
|---|---|
| `validate_datev_extf` | Checks a file (`path`) or pasted text (`content`). Returns header data, error and warning counts, and each finding with line, field, value and an explanation in German (`lang: "de"`, default) or English (`"en"`). The encoding is only checked for files. |
| `explain_datev_finding` | Explains a finding code such as `amount-dot` or `bu-automatic`. |
| `write_buchungsstapel` | Builds a Buchungsstapel (Formatversion 13) from a header and booking rows (amounts in cents), validates it, and writes it as Windows-1252 to `outputPath` or returns the CSV text. |
| `list_datev_columns` | Lists the 125 Buchungsstapel or 254 Debitoren/Kreditoren columns by position. |

Resources: `datev-extf://columns/buchungsstapel`, `datev-extf://columns/debkred`, `datev-extf://findings/de` and `datev-extf://findings/en`.

Prompt: `fix_datev_import` validates a file and proposes fixes for the export that produced it.

### Example

> Why does DATEV reject `~/Downloads/EXTF_Buchungsstapel.csv`?

```
2 errors, 1 warning in 214 data rows (category buchungsstapel, encoding utf-8).
- warning [utf8-without-bom]: The file is UTF-8 without a byte order mark. DATEV then reads it as Windows-1252 and umlauts turn into garbage …
- error line 4 [amount-dot]: Amount “49.90” uses a dot as the decimal separator. DATEV expects a comma: 12.50 becomes 12,50.
- error line 9 [date-leading-zero]: Document date “506” has only three digits: the leading zero is gone. …
```

## Not tax advice

The server checks format, not bookkeeping. It can't tell whether an account or tax key is right for a transaction, and it doesn't pick them when writing. Agree that with your tax advisor.

DATEV and DATEV-Format are trademarks of DATEV eG. This project is not affiliated with or endorsed by DATEV.

## Maintenance

Maintained by [seamless.engineering](https://seamless.engineering) for our own production use: we run managed [DATEV integrations](https://seamless.engineering/de/integrations/) for shops, payment providers and ERPs, fully EU-hosted. Issues and PRs welcome, no SLA.

## Releasing

Bump `version` in `package.json` and both versions in `server.json`, commit, then tag and push: `git tag v0.1.1 && git push origin v0.1.1`. The release workflow publishes to npm with provenance via trusted publishing, then to the [MCP Registry](https://registry.modelcontextprotocol.io) as `engineering.seamless/datev-extf`.

MIT licence.
