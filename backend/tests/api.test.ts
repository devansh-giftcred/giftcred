import request from "supertest";
import { createApp } from "../src/app.js";
import { closePool } from "../src/db.js";

const app = createApp();

afterAll(async () => {
  await closePool();
});

describe("API smoke tests", () => {
  it("GET / returns service index", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("GiftCred Auth API");
    expect(res.body.endpoints).toHaveProperty("catalog");
    expect(res.body.endpoints).toHaveProperty("orders");
  });

  it("GET /health returns ok when database is reachable", async () => {
    const res = await request(app).get("/health");
    if (res.status === 503) {
      console.warn("Skipping DB health assertion — DATABASE_URL unreachable");
      expect(res.body.status).toBe("error");
      return;
    }
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("POST /api/auth/login rejects invalid credentials", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: "nobody@example.com",
      password: "wrong-password-xyz",
    });
    expect(res.status).toBe(401);
  });
});
