import { createHmac } from "node:crypto";
import { WoohooService } from "../src/woohoo/woohoo.service.js";

describe("WoohooService signing", () => {
  beforeAll(() => {
    process.env.WOOHOO_CONSUMER_KEY = process.env.WOOHOO_CONSUMER_KEY ?? "test_consumer_key";
    process.env.WOOHOO_CONSUMER_SECRET =
      process.env.WOOHOO_CONSUMER_SECRET ?? "test_consumer_secret";
    process.env.WOOHOO_USERNAME = process.env.WOOHOO_USERNAME ?? "test_user";
    process.env.WOOHOO_PASSWORD = process.env.WOOHOO_PASSWORD ?? "test_pass";
    process.env.WOOHOO_BASE_URL =
      process.env.WOOHOO_BASE_URL ?? "https://sandbox.woohoo.in";
  });

  const service = new WoohooService();

  it("buildDateAtClient returns UTC ISO format without milliseconds", () => {
    const value = service.buildDateAtClient();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("buildSignatureHeader matches Python HMAC-SHA256 base64 logic", () => {
    const url = "https://sandbox.woohoo.in/rest/v3/catalog/categories";
    const method = "GET";
    const dateAtClient = "2026-06-24T12:00:00Z";
    const secret = process.env.WOOHOO_CONSUMER_SECRET!;

    const expected = createHmac("sha256", secret)
      .update(`${method}&${url}&dateAtClient=${dateAtClient}`)
      .digest("base64");

    expect(service.buildSignatureHeader(url, method, dateAtClient)).toBe(expected);
  });

  it("signUrl produces Authorization header with oauth params", () => {
    const token = {
      oauthToken: "access-token-value",
      oauthTokenSecret: "access-token-secret",
    };
    const { signedUrl, headers } = service.signUrl(
      "GET",
      "https://sandbox.woohoo.in/rest/v3/catalog/categories",
      token
    );

    expect(signedUrl).toContain("sandbox.woohoo.in");
    expect(headers.Authorization).toMatch(/^OAuth /);
    expect(headers.Authorization).toContain("oauth_consumer_key");
    expect(headers.Authorization).toContain("oauth_token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("signUrl includes oauth_verifier when provided", () => {
    const token = {
      oauthToken: "request-token",
      oauthTokenSecret: "request-secret",
    };
    const { headers } = service.signUrl(
      "POST",
      "https://sandbox.woohoo.in/oauth/token",
      token,
      { verifier: "verifier-code-123" }
    );
    expect(headers.Authorization).toContain("oauth_verifier");
  });
});
