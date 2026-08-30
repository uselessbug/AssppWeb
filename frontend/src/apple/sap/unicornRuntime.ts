import { registerBrowserSapSignerFactory } from "../sap";
import { extractAppleSapAssets } from "./assetExtractor";
import { inspectAppleSapPackage } from "./assets";
import { BrowserSapMachine } from "./machine";
import { inspectMachOExports, type MachOExportInspection } from "./machoInspect";
import { exchangeSapSetup, fetchSapCertificate } from "./protocol";
import {
  SAP_COMMERCE_BASE,
  SAP_CORE_FP_BASE,
  SAP_KIT_BASE,
} from "./unicornEngine";

const UNICORN_VERSION = "2.1.4";
const UNICORN_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/@alexaltea/unicorn-js@${UNICORN_VERSION}/dist/unicorn_x86.js`;
const SMOKE_ADDRESS = 0x100000;
const SAP_HIGH_ADDRESS = 0x0000300000000000;
const SMOKE_EXPECTED_RAX = 0x1122334455667788n;
const HOOK_SMOKE_CODE_ADDRESS = 0x110000;
const HOOK_SMOKE_SERVICE_ADDRESS = 0x111000;
const HOOK_SMOKE_STACK_ADDRESS = 0x112000;
const HOOK_SMOKE_STACK_POINTER = HOOK_SMOKE_STACK_ADDRESS + 0x800;
const HOOK_SMOKE_EXPECTED_RAX = 0x7766554433221100n;
const UNICORN_STDERR_LIMIT = 32;

const CORE_FP_EXPORTS = [
  "_WIn9UJ86JKdV4dM",
  "_X46O5IeS",
  "_YlCJ3lg",
  "_dku592fbFAj",
  "_fdjkDSAFjklaf2s",
  "_lxpgvVMLd0S7uRl",
] as const;

export interface UnicornHook {
  handle: number;
  callback: number;
}

export interface UnicornEngine {
  mem_map(address: number, size: number, perms: number): void;
  mem_write(address: number, bytes: Uint8Array | number[]): void;
  mem_read(address: number, size: number): Uint8Array;
  emu_start(begin: number, until: number, timeout: number, count: number): void;
  emu_stop(): void;
  reg_write_i64(regid: number, value: bigint): void;
  reg_read_i64(regid: number): bigint;
  hook_add(
    type: number,
    callback: (...args: any[]) => void,
    userData?: unknown,
    begin?: number,
    end?: number,
    extra?: number,
  ): UnicornHook;
  hook_del(hook: UnicornHook): void;
  close(): void;
}

interface UnicornModuleOptions {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

export interface UnicornX86Module {
  ARCH_X86: number;
  MODE_64: number;
  PROT_ALL: number;
  HOOK_CODE: number;
  HOOK_BLOCK: number;
  X86_REG_RAX: number;
  X86_REG_RDI: number;
  X86_REG_RSI: number;
  X86_REG_RDX: number;
  X86_REG_RCX: number;
  X86_REG_R8: number;
  X86_REG_R9: number;
  X86_REG_RIP: number;
  X86_REG_RSP: number;
  Unicorn: new (arch: number, mode: number) => UnicornEngine;
  __assppStderr?: string[];
}

interface SapDebugApi {
  unicornVersion: string;
  runUnicornX64SmokeTest: () => Promise<UnicornSmokeResult>;
  runUnicornHookReentrySmokeTest: () => Promise<UnicornHookSmokeResult>;
  inspectAppleSapPackage: typeof inspectAppleSapPackage;
  extractAppleSapAssets: typeof extractAppleSapAssets;
  inspectAppleSapMachO: typeof inspectAppleSapMachO;
}

declare global {
  interface Window {
    MUnicorn?: (
      options?: UnicornModuleOptions,
    ) => Promise<UnicornX86Module>;
    __assppSapDebug?: SapDebugApi;
  }
}

export interface UnicornSmokeResult {
  version: string;
  rax: string;
  highAddressRoundTrip: boolean;
}

export interface UnicornHookSmokeResult {
  codeHookCalled: boolean;
  blockHookCalled: boolean;
  stackReturnAddress: string;
  rax: string;
}

export interface AppleSapMachOInspection {
  coreFP: Omit<MachOExportInspection, "symbol">;
  commerceCore: Omit<MachOExportInspection, "symbol">;
  commerceKit: Omit<MachOExportInspection, "symbol">;
  initialize: number;
  exchange: number;
  sign: number;
  teardown: number;
  dispose: number;
}

let modulePromise: Promise<UnicornX86Module> | undefined;
let installed = false;

export function installExperimentalBrowserSapRuntime() {
  if (installed) return;
  installed = true;

  registerBrowserSapSignerFactory(async (config, hardwareId) => {
    const module = await loadUnicornX86Module();
    await runUnicornX64SmokeTest(module);
    await runUnicornHookReentrySmokeTest(module);

    const extraction = await extractAppleSapAssets();
    const machine = BrowserSapMachine.openLinked(module, extraction.bundle);
    const hardware = new Uint8Array(hardwareId);
    let contextValue = 0n;

    try {
      contextValue = machine.initialize(hardware);
      const certificate = await fetchSapCertificate(config.certificateURL);
      const first = machine.exchange(
        config.version,
        hardware,
        contextValue,
        certificate,
      );
      if (first.state !== 1) {
        throw new Error(`SAP setup entered unexpected state ${first.state}`);
      }
      if (first.output.length === 0) {
        throw new Error("SAP setup message is empty");
      }

      const reply = await exchangeSapSetup(config.setupURL, first.output);
      const second = machine.exchange(
        config.version,
        hardware,
        contextValue,
        reply,
      );
      if (second.state !== 0) {
        throw new Error(`SAP setup completed in unexpected state ${second.state}`);
      }

      let closed = false;
      return {
        async sign(input: Uint8Array) {
          if (closed) throw new Error("Browser SAP signer is closed");
          const signature = machine.sign(contextValue, input);
          if (signature.length === 0) {
            throw new Error("Browser SAP signer returned an empty signature");
          }
          return signature;
        },
        async close() {
          if (closed) return;
          closed = true;
          let teardownError: unknown;
          try {
            if (contextValue !== 0n) machine.teardown(contextValue);
          } catch (error) {
            teardownError = error;
          } finally {
            contextValue = 0n;
            hardware.fill(0);
            machine.close();
          }
          if (teardownError) throw teardownError;
        },
      };
    } catch (error) {
      try {
        if (contextValue !== 0n) machine.teardown(contextValue);
      } catch {
        // Preserve the setup failure.
      }
      contextValue = 0n;
      hardware.fill(0);
      try {
        machine.close();
      } catch {
        // Preserve the setup failure after a fatal emulator error.
      }
      throw error;
    }
  });

  if (typeof window !== "undefined") {
    window.__assppSapDebug = {
      unicornVersion: UNICORN_VERSION,
      runUnicornX64SmokeTest: async () =>
        runUnicornX64SmokeTest(await loadUnicornX86Module()),
      runUnicornHookReentrySmokeTest: async () =>
        runUnicornHookReentrySmokeTest(await loadUnicornX86Module()),
      inspectAppleSapPackage,
      extractAppleSapAssets,
      inspectAppleSapMachO,
    };
  }
}

export function inspectAppleSapMachO(
  bundle: Awaited<ReturnType<typeof extractAppleSapAssets>>["bundle"],
): AppleSapMachOInspection {
  const coreFP = inspectMachOExports("CoreFP", bundle.CoreFP);
  const commerceCore = inspectMachOExports("CommerceCore", bundle.CommerceCore);
  const commerceKit = inspectMachOExports("CommerceKit", bundle.CommerceKit);

  for (const name of CORE_FP_EXPORTS) {
    coreFP.symbol(name, SAP_CORE_FP_BASE);
  }
  commerceCore.symbol("_get_mac_address", SAP_COMMERCE_BASE);

  const initialize = commerceKit.symbol("_cp2g1b9ro", SAP_KIT_BASE);
  const exchange = commerceKit.symbol("_Mib5yocT", SAP_KIT_BASE);
  const sign = commerceKit.symbol("_Fc3vhtJDvr", SAP_KIT_BASE);
  const teardown = commerceKit.symbol("_IPaI1oem5iL", SAP_KIT_BASE);
  const dispose = commerceKit.symbol("_jEHf8Xzsv8K", SAP_KIT_BASE);

  const { symbol: _coreSymbol, ...coreFPSummary } = coreFP;
  const { symbol: _commerceCoreSymbol, ...commerceCoreSummary } = commerceCore;
  const { symbol: _commerceKitSymbol, ...commerceKitSummary } = commerceKit;

  return {
    coreFP: coreFPSummary,
    commerceCore: commerceCoreSummary,
    commerceKit: commerceKitSummary,
    initialize,
    exchange,
    sign,
    teardown,
    dispose,
  };
}

export async function loadUnicornX86Module(): Promise<UnicornX86Module> {
  if (modulePromise) return modulePromise;

  modulePromise = loadUnicornScript().then(async () => {
    if (typeof window.MUnicorn !== "function") {
      throw new Error("Unicorn.js loaded without exposing MUnicorn");
    }

    const stderr: string[] = [];
    const module = await window.MUnicorn({
      print: (text) => console.log(text),
      printErr: (text) => {
        const value = String(text);
        stderr.push(value);
        if (stderr.length > UNICORN_STDERR_LIMIT) stderr.shift();
        console.error(value);
      },
    });
    module.__assppStderr = stderr;
    return module;
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
  const highAddressProbe = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);

  try {
    engine.mem_map(SMOKE_ADDRESS, 0x1000, module.PROT_ALL);
    engine.mem_write(SMOKE_ADDRESS, code);
    engine.emu_start(SMOKE_ADDRESS, SMOKE_ADDRESS + code.length, 0, 0);

    const rax = engine.reg_read_i64(module.X86_REG_RAX);
    if (rax !== SMOKE_EXPECTED_RAX) {
      throw new Error(`Unicorn x86_64 smoke test returned RAX=0x${rax.toString(16)}`);
    }

    engine.mem_map(SAP_HIGH_ADDRESS, 0x1000, module.PROT_ALL);
    engine.mem_write(SAP_HIGH_ADDRESS, highAddressProbe);
    const roundTrip = engine.mem_read(SAP_HIGH_ADDRESS, highAddressProbe.length);
    const highAddressRoundTrip = roundTrip.every(
      (value, index) => value === highAddressProbe[index],
    );
    if (!highAddressRoundTrip) {
      throw new Error("Unicorn x86_64 high-address memory round trip failed");
    }

    return {
      version: UNICORN_VERSION,
      rax: `0x${rax.toString(16)}`,
      highAddressRoundTrip,
    };
  } finally {
    engine.close();
  }
}

export async function runUnicornHookReentrySmokeTest(
  module: UnicornX86Module,
): Promise<UnicornHookSmokeResult> {
  const code = new Uint8Array([
    0x48,
    0xb8,
    0x00,
    0x10,
    0x11,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0xff,
    0xd0,
    0x90,
  ]);
  const service = new Uint8Array([0xc3]);
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  let codeHook: UnicornHook | undefined;
  let blockHook: UnicornHook | undefined;
  let codeHookCalled = false;
  let blockHookCalled = false;
  let hookError: Error | undefined;
  let stackReturnAddress = 0n;

  try {
    engine.mem_map(HOOK_SMOKE_CODE_ADDRESS, 0x1000, module.PROT_ALL);
    engine.mem_map(HOOK_SMOKE_SERVICE_ADDRESS, 0x1000, module.PROT_ALL);
    engine.mem_map(HOOK_SMOKE_STACK_ADDRESS, 0x1000, module.PROT_ALL);
    engine.mem_write(HOOK_SMOKE_CODE_ADDRESS, code);
    engine.mem_write(HOOK_SMOKE_SERVICE_ADDRESS, service);
    engine.reg_write_i64(module.X86_REG_RSP, BigInt(HOOK_SMOKE_STACK_POINTER));

    blockHook = engine.hook_add(
      module.HOOK_BLOCK,
      () => {
        blockHookCalled = true;
      },
    );
    codeHook = engine.hook_add(
      module.HOOK_CODE,
      (callbackEngine: UnicornEngine, address: bigint | number) => {
        if (Number(address) !== HOOK_SMOKE_SERVICE_ADDRESS) return;
        codeHookCalled = true;
        try {
          const stackPointer = callbackEngine.reg_read_i64(module.X86_REG_RSP);
          if (
            stackPointer < 0n ||
            stackPointer > BigInt(Number.MAX_SAFE_INTEGER)
          ) {
            throw new Error("hook smoke stack pointer exceeds JavaScript safe range");
          }
          stackReturnAddress = readLittleUint64(
            callbackEngine.mem_read(Number(stackPointer), 8),
          );
          callbackEngine.reg_write_i64(
            module.X86_REG_RAX,
            HOOK_SMOKE_EXPECTED_RAX,
          );
        } catch (error) {
          hookError = error instanceof Error ? error : new Error(String(error));
        }
      },
      undefined,
      HOOK_SMOKE_SERVICE_ADDRESS,
      HOOK_SMOKE_SERVICE_ADDRESS,
    );

    engine.emu_start(
      HOOK_SMOKE_CODE_ADDRESS,
      HOOK_SMOKE_CODE_ADDRESS + code.length,
      0,
      0,
    );

    if (hookError) {
      throw new Error(`Unicorn code-hook re-entry smoke test failed: ${hookError.message}`);
    }
    if (!blockHookCalled) {
      throw new Error("Unicorn block-hook smoke test did not enter the hook");
    }
    if (!codeHookCalled) {
      throw new Error("Unicorn code-hook re-entry smoke test did not enter the hook");
    }

    const expectedReturnAddress = BigInt(HOOK_SMOKE_CODE_ADDRESS + 12);
    if (stackReturnAddress !== expectedReturnAddress) {
      throw new Error(
        `Unicorn code-hook re-entry smoke test observed return address 0x${stackReturnAddress.toString(16)}, expected 0x${expectedReturnAddress.toString(16)}`,
      );
    }

    const rax = engine.reg_read_i64(module.X86_REG_RAX);
    if (rax !== HOOK_SMOKE_EXPECTED_RAX) {
      throw new Error(
        `Unicorn code-hook re-entry smoke test returned RAX=0x${rax.toString(16)}`,
      );
    }

    return {
      codeHookCalled,
      blockHookCalled,
      stackReturnAddress: `0x${stackReturnAddress.toString(16)}`,
      rax: `0x${rax.toString(16)}`,
    };
  } finally {
    for (const hook of [codeHook, blockHook]) {
      if (!hook) continue;
      try {
        engine.hook_del(hook);
      } catch {
        // A fatal Emscripten abort can make cleanup unavailable. Preserve the
        // original execution error rather than masking it with hook cleanup.
      }
    }
    try {
      engine.close();
    } catch {
      // Same rationale as hook cleanup above.
    }
  }
}

function readLittleUint64(input: Uint8Array): bigint {
  if (input.length !== 8) {
    throw new Error(`expected 8-byte uint64, received ${input.length} bytes`);
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  return (
    BigInt(view.getUint32(0, true)) |
    (BigInt(view.getUint32(4, true)) << 32n)
  );
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
