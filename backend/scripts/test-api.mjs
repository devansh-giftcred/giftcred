const base = "http://localhost:3001";

async function req(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

const root = await req("GET", "/");
const health = await req("GET", "/health");
const login = await req("POST", "/api/auth/login", {
  email: "admin@giftcred.com",
  password: "Giftcred@123",
});

console.log("GET /", root.status, root.body);
console.log("GET /health", health.status, health.body);
console.log("POST /api/auth/login", login.status, login.body);
