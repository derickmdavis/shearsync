import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";
import { supabaseAnon } from "../lib/supabase";
import type { AuthUser, RequestAuth } from "../types/api";

interface SupabaseJwtClaims {
  sub?: string;
  email?: string;
  aud?: string | string[];
  iss?: string;
}

interface JwtDiagnostics {
  headerPresent: boolean;
  bearerFormat: boolean;
  tokenLength: number;
  algorithm?: string;
  keyIdPresent: boolean;
  issuer?: string;
  audience?: string | string[];
}

const shouldLogAuthDiagnostics = env.NODE_ENV !== "production";

const decodeJwtSection = <T>(value: string | undefined): T | null => {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
};

const getBearerToken = (authHeader: string | undefined): string | null => {
  if (typeof authHeader !== "string") {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
};

const getJwtDiagnostics = (authHeader: string | undefined, token: string | null): JwtDiagnostics => {
  const parts = token?.split(".") ?? [];
  const header = decodeJwtSection<{ alg?: string; kid?: string }>(parts[0]);
  const claims = decodeJwtSection<SupabaseJwtClaims>(parts[1]);

  return {
    headerPresent: typeof authHeader === "string",
    bearerFormat: typeof authHeader === "string" && /^Bearer\s+\S+$/i.test(authHeader),
    tokenLength: token?.length ?? 0,
    algorithm: header?.alg,
    keyIdPresent: Boolean(header?.kid),
    issuer: claims?.iss,
    audience: claims?.aud
  };
};

const logAuthDiagnostics = (req: Request, event: string, diagnostics: JwtDiagnostics, extra?: Record<string, unknown>) => {
  if (!shouldLogAuthDiagnostics) {
    return;
  }

  const path = req.originalUrl ?? req.url ?? "unknown";
  const details = {
    path,
    ...diagnostics,
    ...extra
  };

  console.info(`[AUTH] ${event} ${JSON.stringify(details)}`);
};

const verifySupabaseToken = async (token: string): Promise<SupabaseJwtClaims> => {
  const { data, error } = await supabaseAnon.auth.getClaims(token);

  if (error || !data?.claims) {
    throw new ApiError(401, "Invalid or expired token", {
      reason: error?.message ?? "Token rejected by Supabase Auth"
    });
  }

  return data.claims as SupabaseJwtClaims;
};

const attachAuth = (req: Request, auth: RequestAuth) => {
  req.auth = auth;

  const user: AuthUser = {
    id: auth.userId,
    email: auth.email
  };

  req.user = user;

  if (env.AUTH_MODE === "dev") {
    console.log(`[AUTH] source=${auth.source} userId=${auth.userId}`);
  }
};

export const requireAuth = async (req: Request, _res: Response, next: NextFunction) => {
  const authHeader = req.header("authorization");
  const token = getBearerToken(authHeader);
  const diagnostics = getJwtDiagnostics(authHeader, token);
  const canUseDevAuthFallback = env.AUTH_MODE === "dev" && env.ENABLE_DEV_AUTH_FALLBACK;

  if (!token) {
    if (diagnostics.headerPresent) {
      logAuthDiagnostics(req, "rejected", diagnostics, {
        reason: "Malformed Authorization header"
      });
      next(new ApiError(401, "Malformed authorization header"));
      return;
    }

    if (canUseDevAuthFallback) {
      if (!env.DEV_AUTH_USER_ID) {
        next(new ApiError(500, "Missing DEV_AUTH_USER_ID for explicit development auth fallback"));
        return;
      }

      attachAuth(req, {
        userId: env.DEV_AUTH_USER_ID,
        email: env.DEV_AUTH_USER_EMAIL,
        source: "dev"
      });
      logAuthDiagnostics(req, "accepted", diagnostics, {
        source: "dev",
        userId: env.DEV_AUTH_USER_ID
      });
      next();
      return;
    }

    logAuthDiagnostics(req, "rejected", diagnostics, {
      reason: "Missing bearer token"
    });
    next(new ApiError(401, "Missing bearer token"));
    return;
  }

  try {
    const decoded = await verifySupabaseToken(token);

    if (!decoded.sub) {
      throw new ApiError(401, "Invalid token subject");
    }

    attachAuth(req, {
      userId: decoded.sub,
      email: decoded.email,
      source: "jwt"
    });

    logAuthDiagnostics(req, "accepted", diagnostics, {
      source: "jwt",
      userId: decoded.sub
    });
    next();
  } catch (error) {
    if (error instanceof ApiError) {
      logAuthDiagnostics(req, "rejected", diagnostics, {
        reason: error.message,
        details: error.details
      });
      next(error);
      return;
    }

    logAuthDiagnostics(req, "rejected", diagnostics, {
      reason: error instanceof Error ? error.message : "Unknown auth verification error"
    });
    next(new ApiError(401, "Invalid or expired token"));
  }
};
