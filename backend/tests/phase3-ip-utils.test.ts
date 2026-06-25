import { isIpAllowed, parseIpAllowlist } from "../src/lib/ipUtils.js";

describe("Phase 3: ipUtils", () => {
  it("allows all IPs when allowlist is empty", () => {
    expect(isIpAllowed("203.0.113.50", [])).toBe(true);
    expect(isIpAllowed("invalid-ip", [])).toBe(true);
  });

  it("matches exact IPv4 addresses", () => {
    const allowlist = ["203.0.113.10", "198.51.100.5"];
    expect(isIpAllowed("203.0.113.10", allowlist)).toBe(true);
    expect(isIpAllowed("198.51.100.5", allowlist)).toBe(true);
    expect(isIpAllowed("203.0.113.11", allowlist)).toBe(false);
  });

  it("matches CIDR ranges", () => {
    const allowlist = ["203.0.113.0/24"];
    expect(isIpAllowed("203.0.113.1", allowlist)).toBe(true);
    expect(isIpAllowed("203.0.113.255", allowlist)).toBe(true);
    expect(isIpAllowed("203.0.114.1", allowlist)).toBe(false);
  });

  it("parses JSONB allowlist values", () => {
    expect(parseIpAllowlist([" 10.0.0.1 ", "192.168.0.0/16"])).toEqual([
      "10.0.0.1",
      "192.168.0.0/16",
    ]);
    expect(parseIpAllowlist(null)).toEqual([]);
  });
});
