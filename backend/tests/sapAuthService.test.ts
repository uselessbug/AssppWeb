import { access, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import {
  MAX_HELPER_OUTPUT_BYTES,
  runSAPAuthentication,
  SAPAuthServiceError,
} from "../src/services/sapAuth.js";

let tempDirs: string[] = [];
const originalHelperPath = config.sapAuthHelperPath;
const originalTimeout = config.sapAuthTimeoutMs;
const originalMaxConcurrency = config.sapAuthMaxConcurrency;

async function helperScript(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asspp-sap-auth-test-"));
  tempDirs.push(dir);
  const helper = path.join(dir, "helper");
  await writeFile(helper, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return helper;
}

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asspp-sap-auth-test-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

async function waitForFile(file: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for helper marker: ${file}`);
}

function accountResultScript(delayMs = 0): string {
  const result = JSON.stringify({
    account: {
      email: "apple-id",
      appleId: "apple-id",
      store: "143441",
      firstName: "A",
      lastName: "B",
      passwordToken: "token",
      directoryServicesIdentifier: "123",
      cookies: [],
      deviceIdentifier: "aabbccddeeff",
    },
  });
  return `process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => process.stdout.write(${JSON.stringify(result)}), ${delayMs}));`;
}

function request() {
  return {
    email: "apple-id-secret",
    password: "password-secret",
    authCode: "654321",
    deviceId: "aabbccddeeff",
    existingCookies: [
      {
        name: "session",
        value: "cookie-value-secret",
        path: "/",
        httpOnly: true,
        secure: true,
      },
    ],
  };
}

function capturedLogs(spies: ReturnType<typeof spyOnLogs>): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .flatMap((call) => call)
    .map(String)
    .join("\n");
}

function spyOnLogs() {
  return [
    vi.spyOn(console, "info").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
  ] as const;
}

beforeEach(() => {
  config.sapAuthTimeoutMs = 2000;
  config.sapAuthMaxConcurrency = 2;
});

afterEach(async () => {
  config.sapAuthHelperPath = originalHelperPath;
  config.sapAuthTimeoutMs = originalTimeout;
  config.sapAuthMaxConcurrency = originalMaxConcurrency;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("runSAPAuthentication", () => {
  it("parses a helper success response", async () => {
    config.sapAuthHelperPath = await helperScript(
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({account:{email:"apple-id",appleId:"apple-id",store:"143441",firstName:"A",lastName:"B",passwordToken:"token",directoryServicesIdentifier:"123",cookies:[],deviceIdentifier:"aabbccddeeff"}})));`,
    );
    const result = await runSAPAuthentication(request());
    expect(result.account?.passwordToken).toBe("token");
  });

  it("passes only the helper environment allowlist", async () => {
    const marker = await tempPath("env.json");
    vi.stubEnv("SAP_AUTH_TEST_SECRET", "must-not-reach-helper");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    config.sapAuthHelperPath = await helperScript(
      `const fs = require("fs"); process.stdin.resume(); process.stdin.on("end", () => { fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({secret:process.env.SAP_AUTH_TEST_SECRET,proxy:process.env.HTTPS_PROXY,cache:process.env.XDG_CACHE_HOME})); process.stdout.write(JSON.stringify({account:{email:"apple-id",appleId:"apple-id",store:"143441",firstName:"A",lastName:"B",passwordToken:"token",directoryServicesIdentifier:"123",cookies:[],deviceIdentifier:"aabbccddeeff"}})); });`,
    );

    await runSAPAuthentication(request());
    const helperEnv = JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
    expect(helperEnv.secret).toBeUndefined();
    expect(helperEnv.proxy).toBe("http://proxy.example:8080");
    expect(typeof helperEnv.cache).toBe("string");
  });

  it("emits safe start and success diagnostics without leaking secrets", async () => {
    const logs = spyOnLogs();
    config.sapAuthHelperPath = await helperScript(
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({account:{email:"result-email-secret",appleId:"result-apple-secret",store:"143441",firstName:"A",lastName:"B",passwordToken:"password-token-secret",directoryServicesIdentifier:"dsid-secret",cookies:[{name:"x",value:"result-cookie-secret",path:"/",httpOnly:true,secure:true}],deviceIdentifier:"device-secret",pod:"42"}})));`,
    );

    await runSAPAuthentication(request());
    const output = capturedLogs(logs);
    expect(output).toContain("[sap-auth] start existingCookieCount=1 hasAuthCode=true");
    expect(output).toContain("[sap-auth] success cookieCount=1 hasPod=true hasStorefront=true");
    for (const secret of [
      "apple-id-secret",
      "password-secret",
      "654321",
      "cookie-value-secret",
      "result-email-secret",
      "result-apple-secret",
      "password-token-secret",
      "dsid-secret",
      "result-cookie-secret",
      "device-secret",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it("emits classified helper-declared failure diagnostics", async () => {
    const logs = spyOnLogs();
    config.sapAuthHelperPath = await helperScript(
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({error:"backend-secret",kind:"authentication",codeRequired:false,eligibleForFreshRetry:true})));`,
    );

    await runSAPAuthentication(request());
    const output = capturedLogs(logs);
    expect(output).toContain("[sap-auth] failure kind=authentication reason=helper_response codeRequired=false eligibleForFreshRetry=true");
    expect(output).not.toContain("backend-secret");
  });

  it("maps a missing executable without exposing request secrets", async () => {
    config.sapAuthHelperPath = path.join(os.tmpdir(), "definitely-missing-asspp-helper");
    await expect(runSAPAuthentication(request())).rejects.toMatchObject({
      kind: "missing",
      message: "SAP authentication helper is not installed",
    });
  });

  it("rejects empty stdout", async () => {
    config.sapAuthHelperPath = await helperScript("process.stdin.resume();");
    await expect(runSAPAuthentication(request())).rejects.toMatchObject({
      kind: "empty",
    });
  });

  it("rejects malformed JSON", async () => {
    config.sapAuthHelperPath = await helperScript(
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("not-json"));`,
    );
    await expect(runSAPAuthentication(request())).rejects.toMatchObject({
      kind: "invalid-json",
    });
  });

  it("rejects valid JSON with an invalid helper response schema", async () => {
    config.sapAuthHelperPath = await helperScript(
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({account:{foo:"bar"}})));`,
    );
    await expect(runSAPAuthentication(request())).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });

  it("kills a timed-out helper and logs timeout distinctly", async () => {
    const logs = spyOnLogs();
    config.sapAuthTimeoutMs = 20;
    config.sapAuthHelperPath = await helperScript(
      `process.stdin.resume(); setTimeout(() => {}, 10000);`,
    );
    await expect(runSAPAuthentication(request())).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(capturedLogs(logs)).toContain(
      "[sap-auth] failure kind=infrastructure reason=helper_timeout",
    );
  });

  it("rejects oversized stdout", async () => {
    config.sapAuthHelperPath = await helperScript(
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("x".repeat(${MAX_HELPER_OUTPUT_BYTES + 1})));`,
    );
    await expect(runSAPAuthentication(request())).rejects.toMatchObject({
      kind: "oversized",
    });
  });

  it("never includes helper stderr in runtime errors or logs", async () => {
    const logs = spyOnLogs();
    const secret = "must-not-leak";
    config.sapAuthHelperPath = await helperScript(
      `process.stderr.write(${JSON.stringify(secret)}); process.exit(2);`,
    );
    try {
      await runSAPAuthentication(request());
      throw new Error("expected helper failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SAPAuthServiceError);
      expect((error as Error).message).not.toContain(secret);
      expect(capturedLogs(logs)).not.toContain(secret);
      expect(capturedLogs(logs)).toContain("reason=helper_failed");
      expect(capturedLogs(logs)).toMatch(/stderrBytes=\d+/);
    }
  });

  it("rejects excess concurrent helpers instead of spawning an unbounded process", async () => {
    const marker = await tempPath("started");
    config.sapAuthMaxConcurrency = 1;
    config.sapAuthHelperPath = await helperScript(
      `const fs = require("fs"); process.stdin.resume(); process.stdin.on("end", () => { fs.writeFileSync(${JSON.stringify(marker)}, "started"); setTimeout(() => process.stdout.write(JSON.stringify({account:{email:"apple-id",appleId:"apple-id",store:"143441",firstName:"A",lastName:"B",passwordToken:"token",directoryServicesIdentifier:"123",cookies:[],deviceIdentifier:"aabbccddeeff"}})), 250); });`,
    );

    const first = runSAPAuthentication(request());
    await waitForFile(marker);
    await expect(runSAPAuthentication(request())).rejects.toMatchObject({
      kind: "busy",
    });
    await expect(first).resolves.toMatchObject({
      account: { passwordToken: "token" },
    });
  });

  it("kills an in-flight helper when the request is aborted and releases its slot", async () => {
    const marker = await tempPath("started");
    const controller = new AbortController();
    config.sapAuthMaxConcurrency = 1;
    config.sapAuthHelperPath = await helperScript(
      `const fs = require("fs"); process.stdin.resume(); process.stdin.on("end", () => { fs.writeFileSync(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 10000); });`,
    );

    const pending = runSAPAuthentication(request(), { signal: controller.signal });
    await waitForFile(marker);
    controller.abort();
    await expect(runSAPAuthentication(request())).rejects.toMatchObject({
      kind: "busy",
    });
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });

    config.sapAuthHelperPath = await helperScript(accountResultScript());
    await expect(runSAPAuthentication(request())).resolves.toMatchObject({
      account: { passwordToken: "token" },
    });
  });
});
