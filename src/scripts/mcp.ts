/**
 * `cogworks mcp` — Model Context Protocol server.
 *
 *   cogworks mcp [--token cwat_…] [--read-only]
 *
 * Boots a stdio MCP server that AI agents (Claude Desktop, Cursor,
 * Continue, ChatGPT plugins) can connect to. Auto-derives tools per
 * collection + 5 generic admin tools. Auth via API token (audience=api,
 * scope mcp:* required).
 *
 * Token lookup precedence:
 *   1. --token <cwat_…> argument
 *   2. COGWORKS_MCP_TOKEN env
 *   3. COGWORKS_API_TOKEN env
 *
 * Error exit codes:
 *   2 — bad / missing token
 *   3 — token has no mcp:* scope
 */

import { initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { stripApiTokenPrefix, hasScope } from "../core/api-tokens.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setUploadDir } from "../core/storage.ts";
import { runStdioServer } from "../mcp/server.ts";
import type { ToolContext } from "../mcp/tools.ts";

interface CliFlags {
  token: string | null;
  readOnly: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { token: null, readOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--token" || a === "-t") {
      out.token = argv[++i] ?? null;
    } else if (a.startsWith("--token=")) {
      out.token = a.slice("--token=".length);
    } else if (a === "--read-only" || a === "--readonly") {
      out.readOnly = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`Usage: cogworks mcp [flags]

Boots an MCP server over stdio. Connect AI agents (Claude Desktop, Cursor,
Continue, ChatGPT) by registering cogworks as an MCP server in their config.

Flags:
  --token, -t <cwat_…>     API token. Required scope: mcp:read or higher.
                           Falls back to COGWORKS_MCP_TOKEN or COGWORKS_API_TOKEN env.
  --read-only              Filter the registry to read-only tools, even if the
                           token has write scopes. Defence-in-depth for ad-hoc
                           debugging sessions.
  --help, -h               Show this message.

Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json
or %APPDATA%\\Claude\\claude_desktop_config.json):

  {
    "mcpServers": {
      "cogworks": {
        "command": "cogworks",
        "args": ["mcp"],
        "env": { "COGWORKS_MCP_TOKEN": "cwat_…" }
      }
    }
  }
`);
}

export async function runMcpCli(
  argv: string[],
  dbPath: string,
  jwtSecret: string,
  logsDir: string,
  uploadDir: string,
): Promise<void> {
  const flags = parseFlags(argv);

  const tokenRaw =
    flags.token ?? process.env.COGWORKS_MCP_TOKEN ?? process.env.COGWORKS_API_TOKEN ?? null;
  if (!tokenRaw) {
    process.stderr.write(
      `cogworks mcp: no token provided. Pass --token cwat_…, or set COGWORKS_MCP_TOKEN env.\n`,
    );
    process.exit(2);
  }

  // Wire shared state — readLogs needs logs dir; storage needs upload dir
  // even though MCP doesn't serve file content (some admin tools probe).
  setLogsDir(logsDir);
  setUploadDir(uploadDir);
  initDb(`file:${dbPath}`);
  await runMigrations();

  const ctx = await verifyAuthToken(stripApiTokenPrefix(tokenRaw), jwtSecret, { audience: "api" });
  if (!ctx?.viaApiToken) {
    process.stderr.write(
      `cogworks mcp: token verification failed. Mint a fresh token with \`cogworks token mint --scope mcp:read\`.\n`,
    );
    process.exit(2);
  }

  const scopes = ctx.scopes ?? [];
  // Require at least one mcp:* scope (or admin) — a token with only
  // 'read'/'write' (REST scopes) shouldn't be usable over MCP.
  const ok = hasScope(scopes, "mcp:read") || hasScope(scopes, "mcp:write");
  if (!ok) {
    process.stderr.write(
      `cogworks mcp: token lacks any mcp:* scope. Has: [${scopes.join(", ")}]. ` +
        `Mint a new token with \`cogworks token mint --scope mcp:read\` (or mcp:write/mcp:admin).\n`,
    );
    process.exit(3);
  }

  const toolCtx: ToolContext = {
    tokenId: ctx.jti ?? "(unknown)",
    tokenName: ctx.tokenName ?? "(unnamed)",
    scopes,
    adminId: ctx.id,
    adminEmail: ctx.email ?? "",
  };

  await runStdioServer({ ctx: toolCtx, readOnly: flags.readOnly });
}
