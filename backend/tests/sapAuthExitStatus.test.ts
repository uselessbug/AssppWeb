import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runSAPAuthentication } from "../src/services/sapAuth.js";

const originalHelperPath = config.sapAuthHelperPath;
const tempDirs: string[] = [];

async function helperScript(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asspp-sap-auth-exit-test-"));
  tempDirs.push(dir);
  const helper = path.join(dir, "helper");
  await writeFile(helper, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return helper;
}

afterEach(async () => {
  config.sapAuthHelperPath = originalHelperPath;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SAP helper exit status", () => {
  it("rejects a valid protocol response from a non-zero helper exit", async () => {
    const result = JSON.stringify({
      account: {
        email: "apple-id",
        appleId: "apple-id",
        store: "143441-1,29",
        firstName: "A",
        lastName: "B",
        passwordToken: "token",
        directoryServicesIdentifier: "123",
        cookies: [],
        deviceIdentifier: "aabbccddeeff",
      },
    });

    config.sapAuthHelperPath = await helperScript(
      `process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(${JSON.stringify(result)}); process.exitCode = 1; });`,
    );

    await expect(
      runSAPAuthentication({
        email: "apple-id",
        password: "password",
        deviceId: "aabbccddeeff",
      }),
    ).rejects.toMatchObject({ kind: "runtime" });
  });
});
