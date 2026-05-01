import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";

export const notFoundHandler = () => {
  throw new ApiError(404, "Route not found");
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        message: "Validation failed",
        details: error.flatten()
      }
    });
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      error: {
        message: error.message,
        details: env.NODE_ENV === "production" ? undefined : error.details
      }
    });
    return;
  }

  res.status(500).json({
    error: {
      message: "Internal server error",
      details: env.NODE_ENV === "production" ? undefined : String(error)
    }
  });
};

