import { registerBrowserSapSignerFactory } from "../sap";

const UNICORN_VERSION = "2.1.4";
const UNICORN_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/@alexaltea/unicorn-js@${UNICORN_VERSION}/dist/unicorn_x86.js`;
const SMOKE_ADDRESS = 0x100000;
const SMOKE_EXPECTED_RAX = 0x1122334455667788n;

interface UnicornEngine {
  mem_map(address: number, size: number, perms: number): void;
  mem_write(address: number, bytes: Uint8Array | number[]): void;
  emu_start(begin: number, until: number, timeout: number, count: number): void;
  reg_read_i64(regid: number): bigint;
  close(): void;
}

export interface UnicornX86Module {
  ARCH_X86: number;
  MODE_64: number;
  PROT_ALL: number;
  X86_REG_RAX: number;
  Unicorn: new (arch: number, mode: number) => UnicornEngine;
}

interface SapDebugApi {
  unicornVersion: string;
  runUnicornX64SmokeTest: () => Promise<UnicornSmokeResult>;
}

declare global {
  interface Window {
    MUnicorn?: () => Promise<UnicornX86Module>;
    __assppSapDebug?: SapDebugApi;
  }
}

export interface UnicornSmokeResult {
  version: string;
  rax: string;
}

let modulePromise: Promise<UnicornX86Module> | undefined;
let installed = false;

export function installExperimentalBrowserSapRuntime() {
  if (installed) return;
  installed = true;

  registerBrowserSapSignerFactory(async () => {
    const module = await loadUnicornX86Module();
    await runUnicornX64SmokeTest(module);

    throw new Error(
      "Browser Unicorn x86_64 runtime is available, but the Apple SAP Mach-O machine and shims have not been ported yet",
    );
  });

  if (typeof window !== "undefined") {
    window.__assppSapDebug = {
      unicornVersion: UNICORN_VERSION,
      runUnicornX64SmokeTest: async () =>
        runUnicornX64SmokeTest(await loadUnicornX86Module()),
    };
  }
}

export async function loadUnicornX86Module(): Promise<UnicornX86Module> {
  if (modulePromise) return modulePromise;

  modulePromise = loadUnicornScript().then(async () => {
    if (typeof window.MUnicorn !== "function") {
      throw new Error("Unicorn.js loaded without exposing MUnicorn");
    }

    return window.MUnicorn();
  });

  try {
    return await modulePromise;
  } catch (error) {
    modulePromise = undefined;
    throw error;
  }
}

export async function runUnicornX64SmokeTest(
  module: UnicornX86Module,
): Promise<UnicornSmokeResult> {
  // mov rax, 0x1122334455667788; nop
  const code = new Uint8Array([
    0x48,
    0xb8,
    0x88,
    0x77,
    0x66,
    0x55,
    0x44,
    0x33,
    0x22,
    0x11,
    0x90,
  ]);
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);

  try {
    engine.mem_map(SMOKE_ADDRESS, 0x1000, module.PROT_ALL);
    engine.mem_write(SMOKE_ADDRESS, code);
    engine.emu_start(
      SMOKE_ADDRESS,
      SMOKE_ADDRESS + code.length,
      0,
      0,
    );

    const rax = engine.reg_read_i64(module.X86_REG_RAX);
    if (rax !== SMOKE_EXPECTED_RAX) {
      throw new Error(
        `Unicorn x86_64 smoke test returned RAX=0x${rax.toString(16)}`,
      );
    }

    return {
      version: UNICORN_VERSION,
      rax: `0x${rax.toString(16)}`,
    };
  } finally {
    engine.close();
  }
}

function loadUnicornScript(): Promise<void> {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("Unicorn.js requires a browser document"));
  }

  if (typeof window.MUnicorn === "function") {
    return Promise.resolve();
  }

  const existing = document.querySelector<HTMLScriptElement>(
    `script[data-asspp-unicorn-version="${UNICORN_VERSION}"]`,
  );
  if (existing) {
    return waitForScript(existing);
  }

  const script = document.createElement("script");
  script.src = UNICORN_SCRIPT_URL;
  script.async = true;
  script.crossOrigin = "anonymous";
  script.referrerPolicy = "no-referrer";
  script.dataset.assppUnicornVersion = UNICORN_VERSION;
  document.head.appendChild(script);

  return waitForScript(script);
}

function waitForScript(script: HTMLScriptElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window.MUnicorn === "function") {
      resolve();
      return;
    }

    const handleLoad = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`Failed to load Unicorn.js ${UNICORN_VERSION}`));
    };
    const cleanup = () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
  });
}
