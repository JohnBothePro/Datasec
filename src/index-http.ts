#!/usr/bin/env node
/**
 * Datasec MCP — remote HTTP (Streamable HTTP on /mcp + legacy SSE on /sse).
 * Bind 0.0.0.0, PORT default 8788.
 * Auth: keys.json (MCP_KEYS_FILE) and/or MCP_API_KEY; Bearer or x-api-key.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createDatasecServer } from "./tools.js";
import { session } from "./client.js";
import {
  allowAnon,
  authConfigured,
  authPublic,
  extractTokenFromHeaders,
  getKeysFilePath,
  loadKeys,
  resolveKey,
  runWithAuth,
  type AuthContext,
} from "./auth.js";

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? "0.0.0.0";
const ACCESS_LOG = join(process.cwd(), "mcp-access.log");

type AnyTransport = StreamableHTTPServerTransport | SSEServerTransport;
const transports: Record<string, AnyTransport> = {};

/** Optional mcp-session-id → key name (for logging; never stores secret). */
const sessionKeyNames: Record<string, string> = {};

declare global {
  namespace Express {
    interface Request {
      datasecAuth?: AuthContext;
    }
  }
}

function accessLog(line: string): void {
  console.error(line);
  try {
    appendFileSync(ACCESS_LOG, line + "\n");
  } catch {
    /* ignore disk errors */
  }
}

function bodyMeta(body: unknown): { bodyType: string; tool: string } {
  if (!body || typeof body !== "object") {
    return { bodyType: typeof body, tool: "-" };
  }
  const b = body as Record<string, unknown>;
  if (Array.isArray(body)) return { bodyType: "array", tool: "-" };
  const bodyType = typeof b.method === "string" ? b.method : typeof body;
  const params = b.params as Record<string, unknown> | undefined;
  const tool =
    params && typeof params.name === "string" ? params.name : "-";
  return { bodyType, tool };
}

function unauthorized(res: Response, message: string): void {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message },
    id: null,
  });
}

function apiKeyGate(req: Request, res: Response, next: NextFunction): void {
  // /health handled separately (partial info without key)
  if (req.path === "/health") {
    next();
    return;
  }

  const configured = authConfigured();
  if (!configured) {
    if (allowAnon()) {
      next();
      return;
    }
    console.error(
      "[datasec-mcp] auth denied: no keys.json and no MCP_API_KEY (set MCP_ALLOW_ANON=true to allow)"
    );
    unauthorized(
      res,
      "Unauthorized: API-Key erforderlich (keys.json / MCP_KEYS_FILE oder MCP_API_KEY)"
    );
    return;
  }

  const token = extractTokenFromHeaders({
    authorization: req.headers.authorization,
    "x-api-key": req.headers["x-api-key"] as string | undefined,
  });
  const ctx = resolveKey(token);
  if (!ctx) {
    accessLog(
      `[datasec-mcp] diag auth FAIL path=${req.path} method=${req.method} ` +
        `hasToken=${Boolean(token)} tokenLen=${token ? String(token).length : 0}`
    );
    unauthorized(
      res,
      "Unauthorized: gültiger API-Key erforderlich (Bearer oder x-api-key)"
    );
    return;
  }

  req.datasecAuth = ctx;
  const { bodyType, tool } = bodyMeta(req.body);
  accessLog(
    `[datasec-mcp] diag auth OK path=${req.path} method=${req.method} ` +
      `key=${ctx.name}/${ctx.role} sid=${String(req.headers["mcp-session-id"] ?? "")} ` +
      `bodyType=${bodyType} tool=${tool}`
  );
  next();
}

function withRequestAuth(
  req: Request,
  res: Response,
  handler: () => Promise<void>
): void {
  const ctx = req.datasecAuth;
  const { bodyType, tool } = bodyMeta(req.body);
  const t0 = Date.now();
  void (async () => {
    try {
      await runWithAuth(ctx, () => handler());
    } catch (error) {
      console.error(
        "[datasec-mcp] handler error:",
        error instanceof Error ? error.message : error
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      if (bodyType === "tools/call" || tool !== "-") {
        const durationMs = Date.now() - t0;
        accessLog(
          `[datasec-mcp] diag timing path=${req.path} bodyType=${bodyType} ` +
            `tool=${tool} durationMs=${durationMs} key=${ctx?.name ?? "-"}`
        );
      }
    }
  })();
}

async function main(): Promise<void> {
  session.reloadToken();
  loadKeys();

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // diag: log who hits /mcp (no secrets)
  app.use((req, _res, next) => {
    if (req.path === "/mcp" || req.path === "/sse" || req.path === "/messages") {
      const ua = String(req.headers["user-agent"] ?? "");
      const accept = String(req.headers["accept"] ?? "");
      const ip = String(
        req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? ""
      );
      const country = String(req.headers["cf-ipcountry"] ?? "");
      const ray = String(req.headers["cf-ray"] ?? "");
      const hasAuth = Boolean(req.headers.authorization);
      const hasKey = Boolean(req.headers["x-api-key"]);
      accessLog(
        `[datasec-mcp] diag access method=${req.method} path=${req.path} ` +
          `ip=${ip} country=${country} ray=${ray} hasAuth=${hasAuth} hasKey=${hasKey} ` +
          `accept=${JSON.stringify(accept)} ua=${JSON.stringify(ua.slice(0, 160))}`
      );
    }
    next();
  });

  app.use(apiKeyGate);

  app.get("/health", (req, res) => {
    const token = extractTokenFromHeaders({
      authorization: req.headers.authorization,
      "x-api-key": req.headers["x-api-key"] as string | undefined,
    });
    const ctx = resolveKey(token);
    const body: Record<string, unknown> = {
      ok: true,
      service: "datasec-mcp",
      env: session.env,
      tokenLoaded: session.tokenLoaded,
      writesEnabled: session.writesEnabled,
      authRequired: authConfigured() || !allowAnon(),
      keysFile: getKeysFilePath(),
      keyCount: loadKeys().length,
    };
    if (ctx) {
      body.auth = authPublic(ctx);
    }
    res.json(body);
  });

  // Streamable HTTP (modern)
  app.all("/mcp", (req, res) => {
    withRequestAuth(req, res, async () => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        const existing = transports[sessionId];
        if (!(existing instanceof StreamableHTTPServerTransport)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Bad Request: Session exists but uses a different transport protocol",
            },
            id: null,
          });
          return;
        }
        transport = existing;
        if (req.datasecAuth && sessionId) {
          sessionKeyNames[sessionId] = req.datasecAuth.name;
        }
      } else if (
        sessionId &&
        !transports[sessionId] &&
        !(req.method === "POST" && isInitializeRequest(req.body))
      ) {
        const { bodyType, tool } = bodyMeta(req.body);
        accessLog(
          `[datasec-mcp] diag STALE session sid=${sessionId} method=${req.method} ` +
            `bodyType=${bodyType} tool=${tool}`
        );
        res.status(404).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message:
              "Session not found: MCP was restarted or session expired. Start a new Claude chat / reconnect the connector.",
          },
          id:
            req.body && typeof req.body === "object" && "id" in req.body
              ? (req.body as { id: unknown }).id
              : null,
        });
        return;
      } else if (
        (!sessionId || !transports[sessionId]) &&
        req.method === "POST" &&
        isInitializeRequest(req.body)
      ) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
            if (req.datasecAuth) {
              sessionKeyNames[sid] = req.datasecAuth.name;
              console.error(
                `[datasec-mcp] session ${sid} auth=${req.datasecAuth.name}/${req.datasecAuth.role}`
              );
            }
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) delete transports[sid];
          if (sid && sessionKeyNames[sid]) delete sessionKeyNames[sid];
        };
        const server = createDatasecServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    });
  });

  // Legacy SSE (older clients / mcp-remote)
  app.get("/sse", (req, res) => {
    withRequestAuth(req, res, async () => {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      if (req.datasecAuth) {
        sessionKeyNames[transport.sessionId] = req.datasecAuth.name;
        console.error(
          `[datasec-mcp] sse session ${transport.sessionId} auth=${req.datasecAuth.name}/${req.datasecAuth.role}`
        );
      }
      res.on("close", () => {
        delete transports[transport.sessionId];
        delete sessionKeyNames[transport.sessionId];
      });
      const server = createDatasecServer();
      await server.connect(transport);
    });
  });

  app.post("/messages", (req, res) => {
    withRequestAuth(req, res, async () => {
      const sessionId = req.query.sessionId as string;
      const existing = transports[sessionId];
      if (!(existing instanceof SSEServerTransport)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Bad Request: Session exists but uses a different transport protocol",
          },
          id: null,
        });
        return;
      }
      if (req.datasecAuth && sessionId) {
        sessionKeyNames[sessionId] = req.datasecAuth.name;
      }
      await existing.handlePostMessage(req, res, req.body);
    });
  });

  app.listen(PORT, HOST, () => {
    const keysPath = getKeysFilePath();
    const n = loadKeys().length;
    const mode = authConfigured()
      ? `keys=${n}${keysPath ? ` @ ${keysPath}` : ""}${
          process.env.MCP_API_KEY?.trim() ? "+MCP_API_KEY" : ""
        }`
      : allowAnon()
        ? "anon"
        : "deny-all";
    console.error(
      `[datasec-mcp] HTTP listening http://${HOST}:${PORT}/mcp ` +
        `(SSE /sse) env=${session.env} tokenLoaded=${session.tokenLoaded} ` +
        `writes=${session.writesEnabled} auth=${mode}`
    );
  });
}

main().catch((err) => {
  console.error("[datasec-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
