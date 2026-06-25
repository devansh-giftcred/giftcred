declare module "passport-microsoft" {
  import type { Strategy as PassportStrategy } from "passport";

  export interface MicrosoftStrategyOptions {
    clientID: string;
    clientSecret: string;
    callbackURL: string;
    tenant?: string;
    scope?: string[];
    authorizationURL?: string;
    tokenURL?: string;
  }

  export class Strategy extends PassportStrategy {
    constructor(
      options: MicrosoftStrategyOptions,
      verify: (
        accessToken: string,
        refreshToken: string,
        profile: import("passport").Profile,
        done: (error: unknown, user?: unknown) => void
      ) => void
    );
  }
}
