const base = "http://localhost:3001";

async function req(method, path, body, token) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const login = await req("POST", "/api/auth/login", {
  email: "admin@giftcred.com",
  password: "Giftcred@123",
});
const token = login.body?.tokens?.accessToken;
const me = await req("GET", "/api/auth/me", null, token);
const accounts = await req("GET", "/api/accounts", null, token);
const roles = await req("GET", "/api/users/roles", null, token);

console.log("POST /api/auth/login", login.status, login.body.user?.email ?? login.body);
console.log("GET /api/auth/me", me.status, me.body.user?.roleSlug ?? me.body);
console.log("GET /api/accounts", accounts.status, `count=${accounts.body.accounts?.length ?? 0}`);
console.log("GET /api/users/roles", roles.status, `count=${roles.body.roles?.length ?? 0}`);
