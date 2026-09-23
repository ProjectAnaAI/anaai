import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
} from "express";

// Handlers are written against the Web Request/Response standard, so they stay
// framework-agnostic and directly testable. This adapter bridges them to Express.
type WebHandler = (request: Request) => Response | Promise<Response>;

// Connection-level headers belong to the Express socket, not the forwarded request.
const skippedRequestHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
]);

function toWebRequest(req: ExpressRequest) {
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || skippedRequestHeaders.has(name)) {
      continue;
    }

    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }

  const body: Buffer | undefined =
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    Buffer.isBuffer(req.body) &&
    req.body.length > 0
      ? req.body
      : undefined;

  return new Request(url, {
    method: req.method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  });
}

async function sendWebResponse(
  res: ExpressResponse,
  response: Response
) {
  res.status(response.status);

  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") {
      res.setHeader(name, value);
    }
  });

  const cookies = response.headers.getSetCookie();

  if (cookies.length > 0) {
    res.setHeader("set-cookie", cookies);
  }

  res.end(Buffer.from(await response.arrayBuffer()));
}

export function webHandler(handler: WebHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      await sendWebResponse(res, await handler(toWebRequest(req)));
    } catch (error) {
      next(error);
    }
  };
}
