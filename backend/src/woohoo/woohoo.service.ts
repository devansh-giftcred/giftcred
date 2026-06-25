import axios, { type AxiosRequestConfig, type Method } from "axios";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import OAuth from "oauth-1.0a";
import type { PoolClient } from "pg";
import { config } from "../config.js";

export class WoohooAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WoohooAuthError";
  }
}

export class WoohooAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WoohooAPIError";
  }
}

export interface TokenPair {
  oauthToken: string;
  oauthTokenSecret: string;
}

export interface HTTPDebugResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const INITIATE_PATH = "/oauth/initiate";
const AUTHORIZE_PATH = "/oauth/authorize/customerVerifier";
const TOKEN_PATH = "/oauth/token";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class WoohooService {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly responsesDir: string;

  private _accessToken: TokenPair | null = null;

  constructor(responsesDir?: string) {
    this.baseUrl = config.woohooBaseUrl();
    this.timeout = config.woohooRequestTimeout();
    this.maxRetries = config.woohooMaxRetries();
    this.responsesDir =
      responsesDir ?? resolve(__dirname, "../../responses");
    mkdirSync(this.responsesDir, { recursive: true });
  }

  private createOAuth(): OAuth {
    return new OAuth({
      consumer: {
        key: config.woohooConsumerKey(),
        secret: config.woohooConsumerSecret(),
      },
      signature_method: "HMAC-SHA1",
      hash_function(baseString, key) {
        return createHmac("sha1", key).update(baseString).digest("base64");
      },
    });
  }

  // ------------------------------------------------------------------ OAuth
  async authenticate(client: PoolClient, force = false): Promise<TokenPair> {
    if (!force) {
      const stored = await this.loadTokenFromDb(client);
      if (stored) {
        this._accessToken = stored;
        return stored;
      }
    }

    const requestToken = await this.getRequestToken();
    const verifier = await this.authorizeRequestToken(requestToken);
    const accessToken = await this.exchangeAccessToken(requestToken, verifier);
    await this.saveTokenToDb(client, accessToken);
    this._accessToken = accessToken;
    return accessToken;
  }

  private async getRequestToken(): Promise<TokenPair> {
    const url = `${this.baseUrl}${INITIATE_PATH}`;
    const response = await this.consumerSignedRequest("GET", url, "request_token");

    if (response.statusCode >= 400) {
      throw new WoohooAuthError(
        `Request token failed with HTTP ${response.statusCode}: ${response.body}`
      );
    }

    const parsed = Object.fromEntries(new URLSearchParams(response.body));
    const token = parsed.oauth_token;
    const secret = parsed.oauth_token_secret;
    if (!token || !secret) {
      throw new WoohooAuthError(`Invalid request token response: ${response.body}`);
    }

    this.saveResponse("01_request_token", { parsed, raw: response.body });
    return { oauthToken: token, oauthTokenSecret: secret };
  }

  private async authorizeRequestToken(requestToken: TokenPair): Promise<string> {
    const url = `${this.baseUrl}${AUTHORIZE_PATH}?oauth_token=${encodeURIComponent(requestToken.oauthToken)}`;
    const formData = new URLSearchParams({
      username: config.woohooUsername(),
      password: config.woohooPassword(),
    });

    const response = await this.unsignedRequest("POST", url, formData.toString(), "verifier");

    if (response.statusCode >= 400) {
      throw new WoohooAuthError(
        `Authorization failed with HTTP ${response.statusCode}: ${response.body}`
      );
    }

    const verifier = this.extractVerifier(response.body);
    if (!verifier) {
      throw new WoohooAuthError(`Verifier missing from authorization response: ${response.body}`);
    }

    this.saveResponse("02_verifier", { verifier, raw: response.body });
    return verifier;
  }

  private async exchangeAccessToken(
    requestToken: TokenPair,
    verifier: string
  ): Promise<TokenPair> {
    const url = `${this.baseUrl}${TOKEN_PATH}`;
    const response = await this.signedRequest("POST", url, {
      token: requestToken,
      verifier,
      stepName: "access_token",
    });

    if (response.statusCode >= 400) {
      throw new WoohooAuthError(
        `Access token exchange failed with HTTP ${response.statusCode}: ${response.body}`
      );
    }

    const parsed = Object.fromEntries(new URLSearchParams(response.body));
    const token = parsed.oauth_token;
    const secret = parsed.oauth_token_secret;
    if (!token || !secret) {
      throw new WoohooAuthError(`Invalid access token response: ${response.body}`);
    }

    this.saveResponse("03_access_token", { parsed, raw: response.body });
    return { oauthToken: token, oauthTokenSecret: secret };
  }

  // ------------------------------------------------------------------ Catalog / order HTTP
  async catalogRequest(
    method: Method,
    url: string,
    options: {
      token: TokenPair;
      jsonBody?: Record<string, unknown>;
      stepName: string;
    }
  ): Promise<HTTPDebugResponse> {
    let response = await this.signedRequest(method, url, {
      token: options.token,
      jsonBody: options.jsonBody,
      stepName: options.stepName,
    });

    if (response.statusCode !== 401) {
      return response;
    }

    const dateHeader = this.buildDateAtClient();
    response = await this.signedRequest(method, url, {
      token: options.token,
      jsonBody: options.jsonBody,
      extraHeaders: { dateAtClient: dateHeader },
      stepName: `${options.stepName}_with_dateAtClient`,
    });

    if (response.statusCode !== 401) {
      return response;
    }

    const signature = this.buildSignatureHeader(url, method, dateHeader);
    response = await this.signedRequest(method, url, {
      token: options.token,
      jsonBody: options.jsonBody,
      extraHeaders: {
        dateAtClient: dateHeader,
        signature,
      },
      stepName: `${options.stepName}_with_dateAtClient_signature`,
    });

    return response;
  }

  // ------------------------------------------------------------------ Persistence
  private async loadTokenFromDb(client: PoolClient): Promise<TokenPair | null> {
    const result = await client.query<{
      access_token: string;
      access_token_secret: string;
    }>(
      `SELECT access_token, access_token_secret
       FROM oauth_tokens
       WHERE is_active = TRUE
       ORDER BY id DESC
       LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      oauthToken: row.access_token,
      oauthTokenSecret: row.access_token_secret,
    };
  }

  private async saveTokenToDb(client: PoolClient, token: TokenPair): Promise<void> {
    await client.query(`UPDATE oauth_tokens SET is_active = FALSE WHERE is_active = TRUE`);
    await client.query(
      `INSERT INTO oauth_tokens (access_token, access_token_secret, is_active)
       VALUES ($1, $2, TRUE)`,
      [token.oauthToken, token.oauthTokenSecret]
    );
  }

  requireAccessToken(): TokenPair {
    if (!this._accessToken) {
      throw new WoohooAuthError("Access token not available. Call authenticate() first.");
    }
    return this._accessToken;
  }

  setAccessToken(token: TokenPair): void {
    this._accessToken = token;
  }

  // ------------------------------------------------------------------ HTTP layer
  private async consumerSignedRequest(
    method: Method,
    url: string,
    stepName: string
  ): Promise<HTTPDebugResponse> {
    const oauth = this.createOAuth();
    const requestData = {
      url,
      method: method.toUpperCase(),
      data: { oauth_callback: "oob" },
    };
    const oauthData = oauth.authorize(requestData);
    const headers: Record<string, string> = {
      ...oauth.toHeader(oauthData),
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    };

    return this.executeRequest(method, url, headers, undefined, stepName);
  }

  private async unsignedRequest(
    method: Method,
    url: string,
    body: string | undefined,
    stepName: string
  ): Promise<HTTPDebugResponse> {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0",
    };
    if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    return this.executeRequest(method, url, headers, body, stepName);
  }

  private async signedRequest(
    method: Method,
    url: string,
    options: {
      token: TokenPair;
      verifier?: string;
      extraParams?: Record<string, string>;
      extraHeaders?: Record<string, string>;
      jsonBody?: Record<string, unknown>;
      stepName?: string;
    }
  ): Promise<HTTPDebugResponse> {
    const { signedUrl, headers } = this.signUrl(method, url, options.token, {
      verifier: options.verifier,
      extraParams: options.extraParams,
    });

    const mergedHeaders = {
      ...headers,
      ...(options.extraHeaders ?? {}),
    };

    return this.executeRequest(
      method,
      signedUrl,
      mergedHeaders,
      options.jsonBody,
      options.stepName ?? "signed"
    );
  }

  /** Exposed for tests — mirrors Python _sign_url */
  signUrl(
    method: Method,
    url: string,
    token: TokenPair,
    options?: { verifier?: string; extraParams?: Record<string, string> }
  ): { signedUrl: string; headers: Record<string, string> } {
    let signedUrl = url;
    if (options?.extraParams) {
      const parsed = new URL(url);
      for (const [key, value] of Object.entries(options.extraParams)) {
        parsed.searchParams.set(key, value);
      }
      signedUrl = parsed.toString();
    }

    const oauth = this.createOAuth();
    const requestData: any = {
      url: signedUrl,
      method: method.toUpperCase(),
    };
    if (options?.verifier) {
      requestData.data = { oauth_verifier: options.verifier };
    }

    const tokenData = {
      key: token.oauthToken,
      secret: token.oauthTokenSecret,
    };

    const oauthData = oauth.authorize(requestData, tokenData);

    const headers: Record<string, string> = {
      ...oauth.toHeader(oauthData),
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    };

    return { signedUrl, headers };
  }

  /** Exposed for tests — mirrors Python _build_signature_header */
  buildSignatureHeader(url: string, method: Method, dateAtClient: string): string {
    const baseString = `${method.toUpperCase()}&${url}&dateAtClient=${dateAtClient}`;
    return createHmac("sha256", config.woohooConsumerSecret())
      .update(baseString)
      .digest("base64");
  }

  buildDateAtClient(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  private async executeRequest(
    method: Method,
    url: string,
    headers: Record<string, string>,
    data?: string | Record<string, unknown>,
    stepName = "request"
  ): Promise<HTTPDebugResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const axiosConfig: AxiosRequestConfig = {
          method,
          url,
          headers,
          timeout: this.timeout,
          validateStatus: () => true,
        };

        if (typeof data === "string") {
          axiosConfig.data = data;
        } else if (data) {
          axiosConfig.data = data;
        }

        const response = await axios.request(axiosConfig);
        const normalizedHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") normalizedHeaders[key] = value;
          else if (Array.isArray(value)) normalizedHeaders[key] = value.join(", ");
        }

        this.saveResponse(`http_${stepName}`, {
          status_code: response.status,
          headers: normalizedHeaders,
          body: typeof response.data === "string" ? response.data : JSON.stringify(response.data),
        });

        const body =
          typeof response.data === "string"
            ? response.data
            : JSON.stringify(response.data ?? {});

        return {
          statusCode: response.status,
          headers: normalizedHeaders,
          body,
        };
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries - 1) {
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
        }
      }
    }
    throw lastError;
  }

  private saveResponse(name: string, payload: unknown): void {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+/, "")
      .slice(0, 15);
    const path = resolve(this.responsesDir, `${timestamp}_${name}.json`);
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
  }

  private extractVerifier(body: string): string | null {
    try {
      const payload = JSON.parse(body) as Record<string, string>;
      return payload.verifier ?? payload.oauth_verifier ?? null;
    } catch {
      const parsed = Object.fromEntries(new URLSearchParams(body));
      return parsed.oauth_verifier ?? parsed.verifier ?? null;
    }
  }

  /** Generate a nonce compatible with Python secrets.token_hex(16) */
  static generateNonce(): string {
    return randomBytes(16).toString("hex");
  }
}
