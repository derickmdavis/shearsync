import { getAppEnvironment } from "../config/env";
import { sanitizeMetadata } from "../lib/safeMetadata";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";

export type ApiRequestLogSeverity = "info" | "warning" | "error" | "critical";

export interface ApiRequestLogInput {
  requestId: string;
  method: string;
  path: string;
  routePattern?: string | null;
  statusCode: number;
  durationMs: number;
  accountUserId?: string | null;
  actorUserId?: string | null;
  errorCode?: string | number | null;
  errorMessage?: string | null;
  severity?: ApiRequestLogSeverity;
  metadata?: unknown;
}

const ERROR_MESSAGE_MAX_LENGTH = 500;
const STATIC_ASSET_PATTERN = /\.(?:css|js|map|png|jpg|jpeg|gif|webp|svg|ico|txt|xml)$/i;

export const getApiRequestLogSeverity = (
  statusCode: number,
  explicitSeverity?: ApiRequestLogSeverity
): ApiRequestLogSeverity => {
  if (explicitSeverity) {
    return explicitSeverity;
  }

  if (statusCode >= 500) {
    return "error";
  }

  if (statusCode >= 400) {
    return "warning";
  }

  return "info";
};

export const shouldSkipApiRequestLog = (path: string): boolean => {
  const pathname = path.split("?")[0] ?? path;
  return pathname === "/health"
    || pathname === "/favicon.ico"
    || pathname.startsWith("/assets/")
    || pathname.startsWith("/static/")
    || STATIC_ASSET_PATTERN.test(pathname);
};

const normalizeNullableString = (value: string | number | null | undefined, maxLength = 200): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const normalizePath = (path: string): string => {
  const pathname = path.split("?")[0] ?? path;
  return pathname || "/";
};

export const apiRequestLogsService = {
  async record(input: ApiRequestLogInput): Promise<Row | null> {
    if (shouldSkipApiRequestLog(input.path)) {
      return null;
    }

    try {
      const { data, error } = await supabaseAdmin
        .from("api_request_logs")
        .insert({
          environment: getAppEnvironment(),
          request_id: input.requestId,
          method: input.method.toUpperCase(),
          path: normalizePath(input.path),
          route_pattern: normalizeNullableString(input.routePattern),
          status_code: input.statusCode,
          duration_ms: Math.max(0, Math.round(input.durationMs)),
          account_user_id: normalizeNullableString(input.accountUserId),
          actor_user_id: normalizeNullableString(input.actorUserId),
          error_code: normalizeNullableString(input.errorCode, 100),
          error_message: normalizeNullableString(input.errorMessage, ERROR_MESSAGE_MAX_LENGTH),
          severity: getApiRequestLogSeverity(input.statusCode, input.severity),
          metadata: sanitizeMetadata(input.metadata ?? {})
        })
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      return data as Row;
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        console.warn("[API_REQUEST_LOGS] record failed", {
          requestId: input.requestId,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      return null;
    }
  }
};
