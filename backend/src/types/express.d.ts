import type { AuthedRequest, AuthContext } from "../types/auth.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      clientIp?: string;
    }
  }
}

export type { AuthedRequest, AuthContext };
