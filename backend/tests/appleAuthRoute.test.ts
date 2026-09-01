import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import appleAuthRoutes, { sanitizeCookies } from "../src/routes/appleAuth.js";
import { runSAPAuthentication } from "../src/services/sapAuth.js";

vi.mock("../src/services/sapAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/sapAuth.js")>();
  return { ...actual, runSAPAuthentication: vi.fn() };
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", appleAuthRoutes);
  return app;
}

describe("sanitizeCookies", () => {
  it("sanitizes legacy cookie shapes without rejecting the request", () => {
    const result = sanitizeCookies([
      { name: "ok", value: "1", path: "/x", domain: "apple.com", expiresAt: 12.9, httpOnly: true, secure: true },
      { name: "missingPath", value: "2" },
      { name: "badPath", value: "3", path: 123, expiresAt: Infinity, httpOnly: "yes", secure: 1 },
      null,
      { value: "missingName" },
      { name: "missingValue" },
    ]);
    expect(result).toEqual([
      { name: "ok", value: "1", path: "/x", domain: "apple.com", expiresAt: 12, httpOnly: true, secure: true },
      { name: "missingPath", value: "2", path: "/", httpOnly: false, secure: false },
      { name: "badPath", value: "3", path: "/", httpOnly: false, secure: false },
    ]);
  });
});

describe("Apple SAP authentication route", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [{ email: "", password: "secret", deviceId: "aabbccddeeff" }],
    [{ email: "apple-id", password: "", deviceId: "aabbccddeeff" }],
    [{ email: "apple-id", password: "secret", deviceId: "bad" }],
  ])("rejects invalid request %#", async (body) => {
    const response = await request(createApp()).post("/api/apple/authenticate").send(body);
    expect(response.status).toBe(400);
    expect(runSAPAuthentication).not.toHaveBeenCalled();
  });

  it("accepts a non-email Apple ID and sanitizes cookies", async () => {
    vi.mocked(runSAPAuthentication).mockResolvedValue({
      account: {
        email: "apple-id",
        appleId: "apple-id",
        store: "143441",
        firstName: "Test",
        lastName: "User",
        passwordToken: "token",
        directoryServicesIdentifier: "123",
        cookies: [],
        deviceIdentifier: "aabbccddeeff",
      },
    });
    const response = await request(createApp()).post("/api/apple/authenticate").send({
      email: " apple-id ",
      password: "secret",
      deviceId: "AABBCCDDEEFF",
      existingCookies: [{ name: "x", value: "y", path: 4, expiresAt: NaN }],
    });
    expect(response.status).toBe(200);
    expect(runSAPAuthentication).toHaveBeenCalledWith(expect.objectContaining({
      email: "apple-id",
      deviceId: "aabbccddeeff",
      existingCookies: [{ name: "x", value: "y", path: "/", httpOnly: false, secure: false }],
    }));
  });

  it("maps 2FA and authentication failures to 401", async () => {
    vi.mocked(runSAPAuthentication).mockResolvedValueOnce({ error: "code required", codeRequired: true });
    let response = await request(createApp()).post("/api/apple/authenticate").send({ email: "id", password: "secret", deviceId: "aabbccddeeff" });
    expect(response.status).toBe(401);
    expect(response.body.codeRequired).toBe(true);

    vi.mocked(runSAPAuthentication).mockResolvedValueOnce({ error: "bad credentials" });
    response = await request(createApp()).post("/api/apple/authenticate").send({ email: "id", password: "secret", deviceId: "aabbccddeeff" });
    expect(response.status).toBe(401);
  });
});
