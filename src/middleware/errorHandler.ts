import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";

export const notFoundHandler = () => {
  throw new ApiError(404, "Route not found");
};

const setErrorLogContext = (
  res: Parameters<ErrorRequestHandler>[2],
  error: { code: string | number; message: string }
) => {
  res.locals = res.locals ?? {};
  res.locals.error = error;
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    setErrorLogContext(res, {
      code: "validation_failed",
      message: "Validation failed"
    });
    res.status(400).json({
      error: {
        message: "Validation failed",
        details: error.flatten()
      }
    });
    return;
  }

  if (error instanceof ApiError) {
    setErrorLogContext(res, {
      code: error.statusCode,
      message: error.message
    });
    res.status(error.statusCode).json({
      error: {
        message: error.message,
        details: env.NODE_ENV === "production" && !error.exposeDetails ? undefined : error.details
      }
    });
    return;
  }

  setErrorLogContext(res, {
    code: 500,
    message: error instanceof Error ? error.message : "Internal server error"
  });
  res.status(500).json({
    error: {
      message: "Internal server error",
      details: env.NODE_ENV === "production" ? undefined : String(error)
    }
  });
};
