import type { RequestHandler } from "express";

const methods = ["GET", "POST", "PATCH"];
const headers = ["Authorization", "Accept", "Content-Type", "x-anaai-business-id", "Idempotency-Key"];
const allowedHeaders = new Set(headers.map((header) => header.toLowerCase()));

// Read once at app creation. No development/production wildcard or implicit
// origin trust. Set ZUDE_CORS_ORIGINS=http://localhost:8081 for Expo web locally.
export function apiCors(configuredOrigins = process.env.ZUDE_CORS_ORIGINS ?? ""): RequestHandler {
  const origins = new Set(configuredOrigins.split(",").map((origin) => origin.trim()).filter(Boolean));
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (origin.includes("*") || !["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error();
    } catch {
      // Never include configuration contents in diagnostics.
      throw new Error("ZUDE_CORS_ORIGINS must contain comma-separated HTTP(S) origins only.");
    }
  }

  return (req, res, next) => {
    res.vary("Origin");
    const origin = req.get("origin");
    if (!origin) return next(); // Native clients and provider webhooks need no CORS grant.

    const preflight = req.method === "OPTIONS" && Boolean(req.get("access-control-request-method"));
    if (preflight) {
      res.vary("Access-Control-Request-Method");
      res.vary("Access-Control-Request-Headers");
      res.setHeader("Cache-Control", "no-store");
      const method = req.get("access-control-request-method")!;
      const requestedHeaders = (req.get("access-control-request-headers") || "")
        .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
      if (!origins.has(origin) || !methods.includes(method) ||
          requestedHeaders.some((header) => !allowedHeaders.has(header))) {
        res.status(403).json({ success: false, code: "CORS_DENIED", error: "Cross-origin request is not allowed." });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
      res.setHeader("Access-Control-Allow-Headers", headers.join(", "));
      res.status(204).end();
      return;
    }

    // CORS controls cross-origin browser access, not authentication. Omitting
    // a grant preserves same-origin proxy flows; bearer/signature checks still run.
    if (origins.has(origin) && methods.includes(req.method)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    // Cookie credential sharing is deliberately not enabled.
    next();
  };
}
