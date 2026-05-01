export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const notFound = (message = "Resource not found") => new ApiError(404, message);

export const requireFound = <T>(value: T | null, message?: string): T => {
  if (!value) {
    throw notFound(message);
  }

  return value;
};

