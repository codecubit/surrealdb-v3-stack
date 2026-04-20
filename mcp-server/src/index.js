#!/usr/bin/env node
// MCP server wrapping the `surreal` CLI (SurrealDB v3).
//
// Tools:
//   - surreal_version     : print the CLI / server version
//   - surreal_is_ready    : HTTP health probe against /health
//   - surreal_sql         : run ad-hoc SurrealQL via `surreal sql`
//   - surreal_import      : apply a .surql file via `surreal import`
//   - surreal_export      : dump a namespace/database to a .surql file
//   - surreal_info        : run INFO FOR DB / TABLE / NS to inspect schema
//
// Env vars (all optional — override per-tool-call with arguments):
//   SURREAL_BIN   path or name of the surreal binary (default: "surreal")
//   SURREAL_URL   default connection URL (e.g. http://127.0.0.1:8000)
//   SURREAL_NS    default namespace
//   SURREAL_DB    default database
//   SURREAL_USER  default username (operator)
//   SURREAL_PASS  default password (operator)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = {
  bin: process.env.SURREAL_BIN || "surreal",
  url: process.env.SURREAL_URL || "",
  ns:  process.env.SURREAL_NS  || "",
  db:  process.env.SURREAL_DB  || "",
  user: process.env.SURREAL_USER || "",
  pass: process.env.SURREAL_PASS || "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, args, { stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) =>
      resolve({ code: -1, stdout, stderr: stderr + `\n[spawn error] ${err.message}` }),
    );
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin != null) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

function resolveConn(args) {
  const url  = args.url  ?? env.url;
  const ns   = args.namespace ?? env.ns;
  const db   = args.database  ?? env.db;
  const user = args.username  ?? env.user;
  const pass = args.password  ?? env.pass;

  const missing = [];
  if (!url)  missing.push("url (or SURREAL_URL)");
  if (missing.length) {
    throw new Error(`missing required: ${missing.join(", ")}`);
  }
  return { url, ns, db, user, pass };
}

function formatResult({ code, stdout, stderr }) {
  const ok = code === 0;
  const body =
    (stdout ? `stdout:\n${stdout}\n` : "") +
    (stderr ? `stderr:\n${stderr}\n` : "") +
    `exit: ${code}`;
  return {
    content: [{ type: "text", text: body.trim() || "(no output)" }],
    isError: !ok,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: "surreal_version",
    description:
      "Print the installed `surreal` CLI version (and, if `url` is provided, the connected server version).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional server URL to probe" },
      },
    },
  },
  {
    name: "surreal_is_ready",
    description:
      "HTTP GET /health against the SurrealDB server URL. Returns 200 when ready.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Server URL (defaults to SURREAL_URL env var)",
        },
      },
    },
  },
  {
    name: "surreal_sql",
    description:
      "Run a SurrealQL statement (or multiple statements separated by `;`) against the configured server using `surreal sql`. Returns the raw output.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The SurrealQL to execute" },
        url: { type: "string" },
        namespace: { type: "string" },
        database: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        pretty: {
          type: "boolean",
          description: "Pretty-print the output (adds `--pretty`)",
          default: true,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "surreal_import",
    description:
      "Apply a SurrealQL file to the server via `surreal import`. Either `path` (an existing file) or `content` (inline SurrealQL) is required.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to a .surql file" },
        content: {
          type: "string",
          description: "Inline SurrealQL; written to a temp file before import",
        },
        url: { type: "string" },
        namespace: { type: "string" },
        database: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
      },
    },
  },
  {
    name: "surreal_export",
    description:
      "Export the current namespace/database to a SurrealQL file via `surreal export`. If `path` is omitted, the dump is returned inline.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Destination file path" },
        url: { type: "string" },
        namespace: { type: "string" },
        database: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
      },
    },
  },
  {
    name: "surreal_info",
    description:
      "Inspect schema via `INFO FOR DB`, `INFO FOR TABLE <name>`, or `INFO FOR NS`. Returns table/field/index/event definitions.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["NS", "DB", "TABLE"],
          description: "What to inspect: NS (namespace), DB (database), TABLE (specific table)",
          default: "DB",
        },
        table: {
          type: "string",
          description: "Table name (required when scope is TABLE)",
        },
        url: { type: "string" },
        namespace: { type: "string" },
        database: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function doVersion(args) {
  const cliRes = await run(env.bin, ["--version"]);
  let body = `CLI: ${cliRes.stdout.trim() || "(no output)"}`;
  if (args?.url || env.url) {
    try {
      const r = await fetch(new URL("/version", args?.url || env.url));
      body += `\nServer: ${(await r.text()).trim()}`;
    } catch (err) {
      body += `\nServer: unreachable (${err.message})`;
    }
  }
  return { content: [{ type: "text", text: body }] };
}

async function doIsReady(args) {
  const url = args?.url || env.url;
  if (!url) throw new Error("missing url (or SURREAL_URL)");
  try {
    const r = await fetch(new URL("/health", url));
    const ok = r.status === 200;
    return {
      content: [
        {
          type: "text",
          text: `${url} → HTTP ${r.status} ${ok ? "(ready)" : "(NOT ready)"}`,
        },
      ],
      isError: !ok,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `${url} → unreachable: ${err.message}` }],
      isError: true,
    };
  }
}

async function doSql(args) {
  const conn = resolveConn(args);
  if (!args.query) throw new Error("missing query");

  const cliArgs = ["sql", "--conn", conn.url];
  if (conn.ns)  cliArgs.push("--ns", conn.ns);
  if (conn.db)  cliArgs.push("--db", conn.db);
  if (conn.user) cliArgs.push("--user", conn.user);
  if (conn.pass) cliArgs.push("--pass", conn.pass);
  if (args.pretty !== false) cliArgs.push("--pretty");

  return formatResult(await run(env.bin, cliArgs, { stdin: args.query }));
}

async function doImport(args) {
  const conn = resolveConn(args);

  let path = args.path;
  let cleanup = null;
  if (!path) {
    if (!args.content) throw new Error("provide either path or content");
    const dir = await mkdtemp(join(tmpdir(), "surrealdb-import-"));
    path = join(dir, "inline.surql");
    await writeFile(path, args.content, "utf8");
    cleanup = path;
  }

  const cliArgs = ["import", "--conn", conn.url];
  if (conn.ns)   cliArgs.push("--ns", conn.ns);
  if (conn.db)   cliArgs.push("--db", conn.db);
  if (conn.user) cliArgs.push("--user", conn.user);
  if (conn.pass) cliArgs.push("--pass", conn.pass);
  cliArgs.push(path);

  const res = await run(env.bin, cliArgs);

  if (cleanup) {
    // best-effort; don't fail the tool if unlink errors
    try {
      await (await import("node:fs/promises")).unlink(cleanup);
    } catch {}
  }
  return formatResult(res);
}

async function doExport(args) {
  const conn = resolveConn(args);

  const useTemp = !args.path;
  let path = args.path;
  if (useTemp) {
    const dir = await mkdtemp(join(tmpdir(), "surrealdb-export-"));
    path = join(dir, "dump.surql");
  }

  const cliArgs = ["export", "--conn", conn.url];
  if (conn.ns)   cliArgs.push("--ns", conn.ns);
  if (conn.db)   cliArgs.push("--db", conn.db);
  if (conn.user) cliArgs.push("--user", conn.user);
  if (conn.pass) cliArgs.push("--pass", conn.pass);
  cliArgs.push(path);

  const res = await run(env.bin, cliArgs);
  if (res.code !== 0) return formatResult(res);

  if (useTemp) {
    const body = await readFile(path, "utf8");
    return {
      content: [
        { type: "text", text: `Exported ${body.length} bytes:\n\n${body}` },
      ],
    };
  }
  return {
    content: [{ type: "text", text: `Exported to ${path}` }],
  };
}

async function doInfo(args) {
  const conn = resolveConn(args);
  const scope = (args.scope || "DB").toUpperCase();

  let query;
  if (scope === "TABLE") {
    if (!args.table) throw new Error("missing table name for INFO FOR TABLE");
    query = `INFO FOR TABLE ${args.table};`;
  } else if (scope === "NS") {
    query = "INFO FOR NS;";
  } else {
    query = "INFO FOR DB;";
  }

  const cliArgs = ["sql", "--conn", conn.url];
  if (conn.ns)   cliArgs.push("--ns", conn.ns);
  if (conn.db)   cliArgs.push("--db", conn.db);
  if (conn.user) cliArgs.push("--user", conn.user);
  if (conn.pass) cliArgs.push("--pass", conn.pass);
  cliArgs.push("--pretty");

  return formatResult(await run(env.bin, cliArgs, { stdin: query }));
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "surrealdb-v3", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "surreal_version":  return await doVersion(args || {});
      case "surreal_is_ready": return await doIsReady(args || {});
      case "surreal_sql":      return await doSql(args || {});
      case "surreal_import":   return await doImport(args || {});
      case "surreal_export":   return await doExport(args || {});
      case "surreal_info":     return await doInfo(args || {});
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error in ${name}: ${err.message}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
