import { registerBrowserSapSignerFactory } from "../sap";
import { extractAppleSapAssets } from "./assetExtractor";
import { inspectAppleSapPackage } from "./assets";
import { BrowserSapMachine } from "./machine";
import { inspectMachOExports, type MachOExportInspection } from "./machoInspect";
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

export interface UnicornX86Module {
  ARCH_X86: number;
  MODE_64: number;
  PROT_ALL: number;
  HOOK_CODE: number;
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
}

interface SapDebugApi {
  unicornVersion: string;
  runUnicornX64SmokeTest: () => Promise<UnicornSmokeResult>;
  inspectAppleSapPackage: typeof inspectAppleSapPackage;
  extractAppleSapAssets: typeof extractAppleSapAssets;
  inspectAppleSapMachO: typeof inspectAppleSapMachO;
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
  highAddressRoundTrip: boolean;
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

  registerBrowserSapSignerFactory(async () => {
    const module = await loadUnicornX86Module();
    await runUnicornX64SmokeTest(module);

    const extraction = await extractAppleSapAssets();
    const machine = BrowserSapMachine.openLinked(module, extraction.bundle);
    try {
      const summary = machine.summary();
      if (!summary) {
        throw new Error("Browser SAP linked machine did not expose a link summary");
      }

      throw new Error(
        `Browser SAP dyld relocation and image mapping succeeded from ${extraction.source ?? "network"}: CoreFP(rebase=${summary.coreFP.rebases},bind=${summary.coreFP.binds}), CommerceCore(rebase=${summary.commerceCore.rebases},bind=${summary.commerceCore.binds}), CommerceKit(rebase=${summary.commerceKit.rebases},bind=${summary.commerceKit.binds}), shimImports=${summary.shimImports}; executable shim services and guest SAP initialization are the next required stage`,
      );
    } finally {
      machine.close();
    }
  });

  if (typeof window !== "undefined") {
    window.__assppSapDebug = {
      unicornVersion: UNICORN_VERSION,
      runUnicornX64SmokeTest: async () =>
        runUnicornX64SmokeTest(await loadUnicornX86Module()),
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
