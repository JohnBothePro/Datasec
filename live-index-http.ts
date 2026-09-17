#!/usr/bin/env node
/**
 * Datasec MCP â€” remote HTTP (Streamable HTTP on /mcp + legacy SSE on /sse).
 * Bind 0.0.0.0, PORT default 8788.
 * Optional MCP_API_KEY â†’ require Authorization: Bearer â€¦ or x-api-key.
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createDatasecServer } from "./tools.js";
import { session } from "./client.js";

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? "0.0.0.0";
const API_KEY = process.env.MCP_API_KEY?.trim() || null;

type AnyTransport = StreamableHTTPServerTransport | SSEServerTransport;
const transports: Record<string, AnyTransport> = {};

function apiKeyGate(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    next();
    return;
  }
  const auth = req.headers.authorization ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const headerKey = (req.headers["x-api-key"] as string | undefined)?.trim() ?? "";
  const ok = bearer === API_KEY || headerKey === API_KEY;
  if (!ok) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: MCP_API_KEY required (Bearer or x-api-key)" },
      id: null,
    });
    return;
  }
  next();
}

async function main(): Promise<void> {
  session.reloadToken();

  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(apiKeyGate);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "datasec-mcp",
      env: session.env,
      tokenLoaded: session.tokenLoaded,
      writesEnabled: session.writesEnabled,
      apiKeyRequired: Boolean(API_KEY),
    });
  });

  // Streamable HTTP (modern)
  app.all("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        const existing = transports[sessionId];
        if (!(existing instanceof StreamableHTTPServerTransport)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: Session exists but uses a different transport protocol",
            },
            id: null,
          });
          return;
        }
        transport = existing;
      } else if (sessionId && !transports[sessionId] && !(req.method === "POST" && isInitializeRequest(req.body))) {
        const sline = `[datasec-mcp] diag STALE session sid=${sessionId} method=${req.method} bodyType=${(req.body as any)?.method ?? "-"}`;
        console.error(sline);
        res.status(404).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Session not found: MCP was restarted or session expired. Start a new Claude chat / reconnect the connector.",
          },
          id: (req.body as any)?.id ?? null,
        });
        return;
      } else if ((!sessionId || !transports[sessionId]) && req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) delete transports[sid];
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
    } catch (error) {
      console.error("[datasec-mcp] /mcp error:", error instanceof Error ? error.message : error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Legacy SSE (older clients / mcp-remote)
  app.get("/sse", async (_req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    res.on("close", () => {
      delete transports[transport.sessionId];
    });
    const server = createDatasecServer();
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const existing = transports[sessionId];
    if (!(existing instanceof SSEServerTransport)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: Session exists but uses a different transport protocol",
        },
        id: null,
      });
      return;
    }
    await existing.handlePostMessage(req, res, req.body);
  });

  app.listen(PORT, HOST, () => {
    console.error(
      `[datasec-mcp] HTTP listening http://${HOST}:${PORT}/mcp ` +
        `(SSE /sse) env=${session.env} tokenLoaded=${session.tokenLoaded} ` +
        `writes=${session.writesEnabled} apiKey=${API_KEY ? "required" : "off"}`
    );
  });
}

main().catch((err) => {
  console.error("[datasec-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});

