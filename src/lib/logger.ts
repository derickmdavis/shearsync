import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

const redactUndefined = (fields: LogFields): LogFields =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

const writeLog = (level: LogLevel, event: string, fields: LogFields = {}) => {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const payload = redactUndefined({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...fields
  });
  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.info(line);
};

export const logger = {
  info(event: string, fields?: LogFields) {
    writeLog("info", event, fields);
  },

  warn(event: string, fields?: LogFields) {
    writeLog("warn", event, fields);
  },

  error(event: string, fields?: LogFields) {
    writeLog("error", event, fields);
  }
};

const getRequestId = (req: Request): string => {
  const existingRequestId = req.header("x-request-id");
  return typeof existingRequestId === "string" && existingRequestId.trim().length > 0
    ? existingRequestId.trim().slice(0, 120)
    : randomUUID();
};

const getPublicStylistSlug = (req: Request): string | undefined => {
  if (typeof req.params?.slug === "string") {
    return req.params.slug;
  }

  const path = req.originalUrl ?? req.url ?? "";
  const match = path.match(/^\/(?:api\/public\/(?:stylists|services|availability)\/|book\/)([a-z0-9]+(?:-[a-z0-9]+)*)/);
  return match?.[1];
};

const getRoute = (req: Request): string => {
  const baseUrl = req.baseUrl ?? "";
  const routePath = req.route?.path;

  if (typeof routePath === "string") {
    return `${baseUrl}${routePath}` || req.path;
  }

  return req.path ?? req.originalUrl ?? req.url ?? "unknown";
};

export const requestObservability = (req: Request, res: Response, next: NextFunction) => {
  const requestId = getRequestId(req);
  const startedAt = process.hrtime.bigint();
  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  res.on("finish", () => {
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const statusCode = res.statusCode;
    const error = res.locals.error as { code?: unknown; message?: unknown } | undefined;

    logger.info("http_request_completed", {
      requestId,
      method: req.method,
      route: getRoute(req),
      path: req.originalUrl ?? req.url,
      statusCode,
      latencyMs: Math.round(latencyMs * 100) / 100,
      userId: req.auth?.userId,
      publicStylistSlug: getPublicStylistSlug(req),
      errorCode: error?.code,
      errorMessage: error?.message
    });
  });

  next();
};
