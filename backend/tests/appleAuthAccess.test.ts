import { createHash } from "crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const helperAccount = {
  email: "apple-id",
  appleId: "apple-id",
  store: "143441",
  firstName: "Test",
  lastName: "User",
  passwordToken: "token",
  directoryServicesIdentifier: "123",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
};

async function createApp(
  accessPassword: string,
  unsafeAllowPublicAppleAuth = false,
) {
  vi.resetModules();
  vi.stubEnv("ACCESS_PASSWORD", accessPassword);
  vi.stubEnv(
    "UNSAFE_ALLOW_PUBLIC_APPLE_AUTH",
    unsafeAllowPublicAppleAuth ? "true" : "false",
  );
  vi.doMock("../src/services/sapAuth.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/services/sapAuth.js")>();
    return {
      ...actual,
      runSAPAuthentication: vi.fn().mockResolvedValue({ account: helperAccount }),
    };
  });

  const { accessAuth } = await import("../src/middleware/accessAuth.js");
  const { default: authRoutes } = await import("../src/routes/auth.js");
  const { default: appleAuthRoutes } = await import("../src/routes/appleAuth.js");
  const app = express();
  app.use("/api", accessAuth);
  app.use(express.json());
  app.use("/api", authRoutes);
  app.use("/api", appleAuthRoutes);
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../src/services/sapAuth.js");
  vi.resetModules();
});

describe("Apple authentication ACCESS_PASSWORD protection", () => {
  it("rejects a missing header when access protection is enabled", async () => {
    const app = await createApp("test-access-password");
    const response = await request(app).post("/api/apple/authenticate").send({
      email: "apple-id",
      password: "secret",
      deviceId: "aabbccddeeff",
    });
    expect(response.status).toBe(401);
  });

  it("rejects an unauthorized malformed JSON body before parsing it", async () => {
    const app = await createApp("test-access-password");
    const response = await request(app)
      .post("/api/apple/authenticate")
      .set("Content-Type", "application/json")
      .send("{not-json");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("keeps /auth/verify usable after accessAuth is moved before the JSON parser", async () => {
    const password = "test-access-password";
    const token = createHash("sha256").update(password).digest("hex");
    const app = await createApp(password);
    const response = await request(app).post("/api/auth/verify").send({ token });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("allows the existing access token header when protection is enabled", async () => {
    const password = "test-access-password";
    const token = createHash("sha256").update(password).digest("hex");
    const app = await createApp(password);
    const response = await request(app)
      .post("/api/apple/authenticate")
      .set("X-Access-Token", token)
      .send({ email: "apple-id", password: "secret", deviceId: "aabbccddeeff" });
    expect(response.status).toBe(200);
  });

  it.each([
    "/api/apple/authenticate",
    "/api/apple/authenticate/",
    "/api/APPLE/AUTHENTICATE",
  ])("blocks %s by default when access protection is disabled", async (url) => {
    const app = await createApp("");
    const response = await request(app).post(url).send({
      email: "apple-id",
      password: "secret",
      deviceId: "aabbccddeeff",
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      kind: "infrastructure",
      reason: "access_protection_required",
      eligibleForFreshRetry: false,
    });
  });

  it("allows an explicit unsafe public Apple authentication opt-in", async () => {
    const app = await createApp("", true);
    const response = await request(app).post("/api/apple/authenticate").send({
      email: "apple-id",
      password: "secret",
      deviceId: "aabbccddeeff",
    });
    expect(response.status).toBe(200);
  });
});
