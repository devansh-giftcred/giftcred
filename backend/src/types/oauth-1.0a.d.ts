declare module "oauth-1.0a" {
  export interface OAuthOptions {
    consumer: { key: string; secret: string };
    signature_method?: string;
    hash_function: (baseString: string, key: string) => string;
  }

  export interface RequestData {
    url: string;
    method: string;
    data?: Record<string, string>;
  }

  export default class OAuth {
    constructor(options: OAuthOptions);
    authorize(request: RequestData, token?: { key: string; secret: string }): Record<string, string>;
    toHeader(oauthData: Record<string, string>): Record<string, string>;
  }
}
