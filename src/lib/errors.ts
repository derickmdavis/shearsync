export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;
  public readonly exposeDetails: boolean;
  public readonly severity?: ErrorSeverity;

  constructor(
    statusCode: number,
    message: string,
    details?: unknown,
    options: { exposeDetails?: boolean; severity?: ErrorSeverity } = {}
  ) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.exposeDetails = options.exposeDetails === true;
    this.severity = options.severity;
  }
}

export const getErrorSeverity = (error: unknown, statusCode: number): ErrorSeverity => {
  if (error instanceof ApiError && error.severity) {
    return error.severity;
  }

  if (statusCode >= 500) {
    return "error";
  }

  if (statusCode >= 400) {
    return "warning";
  }

  return "info";
};

export const notFound = (message = "Resource not found") => new ApiError(404, message);

export const requireFound = <T>(value: T | null, message?: string): T => {
  if (!value) {
    throw notFound(message);
  }

  return value;
};
