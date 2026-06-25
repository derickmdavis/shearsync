import type { AuthUser, RequestAdmin, RequestAuth } from "./api";

declare global {
  namespace Express {
    interface Request {
      auth?: RequestAuth;
      admin?: RequestAdmin;
      requestId?: string;
      user?: AuthUser;
    }
  }
}

export {};
