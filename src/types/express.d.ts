import type { AuthUser, RequestAuth } from "./api";

declare global {
  namespace Express {
    interface Request {
      auth?: RequestAuth;
      user?: AuthUser;
    }
  }
}

export {};
