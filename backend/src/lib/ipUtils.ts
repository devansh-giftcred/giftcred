import ipaddr from "ipaddr.js";

export function parseIpAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

export function isIpAllowed(clientIp: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;

  let parsedClient: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsedClient = ipaddr.process(clientIp);
  } catch {
    return false;
  }

  for (const entry of allowlist) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    if (trimmed.includes("/")) {
      try {
        const [network, prefix] = ipaddr.parseCIDR(trimmed);
        if (parsedClient.kind() === network.kind() && parsedClient.match(network, prefix)) {
          return true;
        }
      } catch {
        continue;
      }
      continue;
    }

    try {
      const allowed = ipaddr.process(trimmed);
      if (parsedClient.toString() === allowed.toString()) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}
