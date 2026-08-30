import type { AppleSapAssetBundle } from "./cpio";
import { inspectMachOExports } from "./machoInspect";
import { BrowserMachODyldImage } from "./machoDyld64";
import { BrowserSapShimTable } from "./shims";
import {
  BrowserUnicornEngine,
  SAP_COMMERCE_BASE,
  SAP_CORE_FP_BASE,
  SAP_HEAP_BASE,
  SAP_HEAP_SIZE,
  SAP_KIT_BASE,
  SAP_PAGE_SIZE,
  SAP_RETURN_ADDRESS,
  SAP_SCRATCH_BASE,
  SAP_SCRATCH_SIZE,
  SAP_SHIM_BASE,
  SAP_STACK_BASE,
  SAP_STACK_END,
  SAP_STACK_SIZE,
} from "./unicornEngine";
import type { UnicornX86Module } from "./unicornRuntime";

const SAP_SHIM_SIZE = 0x00100000;
const SAP_EXECUTION_TIMEOUT_MS = 10_000;
const SAP_MAX_OUTPUT_SIZE = 16 << 20;
const UINT32_MAX = 0xffffffff;
const CORE_FP_EXPORT_NAMES = [
  "_WIn9UJ86JKdV4dM",
  "_X46O5IeS",
  "_YlCJ3lg",
  "_dku592fbFAj",
  "_fdjkDSAFjklaf2s",
  "_lxpgvVMLd0S7uRl",
] as const;

interface BrowserSapEntryPoints {
  initialize: number;
  exchange: number;
  sign: number;
  teardown: number;
  dispose: number;
}

export interface BrowserSapLinkSummary {
  coreFP: ReturnType<BrowserMachODyldImage["summary"]>;
  commerceCore: ReturnType<BrowserMachODyldImage["summary"]>;
  commerceKit: ReturnType<BrowserMachODyldImage["summary"]>;
  shimImports: number;
  shimNames: string[];
}

export interface BrowserSapExchangeResult {
  output: Uint8Array;
  state: number;
}

export class BrowserSapMachine {
  private closed = false;
  private scratchCursor = 0;

  private constructor(
    private readonly engine: BrowserUnicornEngine,
    private readonly shims?: BrowserSapShimTable,
    private readonly entry?: BrowserSapEntryPoints,
    private readonly linkSummary?: BrowserSapLinkSummary,
  ) {}

  static open(module: UnicornX86Module): BrowserSapMachine {
    const engine = createBaseEngine(module);
    return new BrowserSapMachine(engine);
  }

  static openLinked(
    module: UnicornX86Module,
    bundle: AppleSapAssetBundle,
  ): BrowserSapMachine {
    const engine = createBaseEngine(module);
    let shims: BrowserSapShimTable | undefined;

    try {
      const coreFPExports = inspectMachOExports("CoreFP", bundle.CoreFP);
      const commerceCoreExports = inspectMachOExports(
        "CommerceCore",
        bundle.CommerceCore,
      );
      const commerceKitExports = inspectMachOExports(
        "CommerceKit",
        bundle.CommerceKit,
      );

      const coreExportMap = new Map<string, number>();
      for (const name of CORE_FP_EXPORT_NAMES) {
        coreExportMap.set(name, coreFPExports.symbol(name, SAP_CORE_FP_BASE));
      }

      const entry: BrowserSapEntryPoints = {
        initialize: commerceKitExports.symbol("_cp2g1b9ro", SAP_KIT_BASE),
        exchange: commerceKitExports.symbol("_Mib5yocT", SAP_KIT_BASE),
        sign: commerceKitExports.symbol("_Fc3vhtJDvr", SAP_KIT_BASE),
        teardown: commerceKitExports.symbol("_IPaI1oem5iL", SAP_KIT_BASE),
        dispose: commerceKitExports.symbol("_jEHf8Xzsv8K", SAP_KIT_BASE),
      };

      const coreFP = BrowserMachODyldImage.open("CoreFP", bundle.CoreFP);
      const commerceCore = BrowserMachODyldImage.open(
        "CommerceCore",
        bundle.CommerceCore,
      );
      const commerceKit = BrowserMachODyldImage.open(
        "CommerceKit",
        bundle.CommerceKit,
      );
      shims = new BrowserSapShimTable(engine, coreExportMap, bundle.CoreFPICXS);

      const resolve = (name: string): number => {
        const candidates = [
          [coreFPExports, SAP_CORE_FP_BASE],
          [commerceCoreExports, SAP_COMMERCE_BASE],
          [commerceKitExports, SAP_KIT_BASE],
        ] as const;

        for (const [image, base] of candidates) {
          try {
            return image.symbol(name, base);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.includes("was not found")
            ) {
              continue;
            }
            throw error;
          }
        }

        return shims!.resolve(name);
      };

      coreFP.relocate(SAP_CORE_FP_BASE, resolve);
      commerceCore.relocate(SAP_COMMERCE_BASE, resolve);
      commerceKit.relocate(SAP_KIT_BASE, resolve);

      coreFP.load(engine);
      commerceCore.load(engine);
      commerceKit.load(engine);

      const shimSummary = shims.summary();
      return new BrowserSapMachine(engine, shims, entry, {
        coreFP: coreFP.summary(),
        commerceCore: commerceCore.summary(),
        commerceKit: commerceKit.summary(),
        shimImports: shimSummary.imports,
        shimNames: shims.names(),
      });
    } catch (error) {
      try {
        shims?.close();
      } catch {
        // Preserve the original linking failure.
      }
      try {
        engine.close();
      } catch {
        // Preserve the original linking failure.
      }
      throw error;
    }
  }

  summary(): BrowserSapLinkSummary | undefined {
    if (!this.linkSummary) return undefined;
    return {
      ...this.linkSummary,
      shimNames: [...this.linkSummary.shimNames],
    };
  }

  initialize(hardwareId: Uint8Array): bigint {
    const entry = this.requireEntry();
    this.requireShims();
    const hardware = createHardwareBlock(hardwareId);

    this.beginCall();
    try {
      const contextField = this.scratch(undefined, 8);
      const hardwareAddress = this.scratch(hardware, hardware.length);
      const status = this.invoke(
        entry.initialize,
        BigInt(contextField),
        BigInt(hardwareAddress),
      );
      const signedStatus = Number(BigInt.asIntN(32, status));
      if (signedStatus !== 0) {
        throw new Error(`SAP initialization returned ${signedStatus}`);
      }

      const contextValue = this.readUint64(contextField);
      if (contextValue === 0n) {
        throw new Error("SAP initialization returned a null context");
      }
      return contextValue;
    } finally {
      this.clearScratch();
    }
  }

  exchange(
    version: number,
    hardwareId: Uint8Array,
    contextValue: bigint,
    input: Uint8Array,
  ): BrowserSapExchangeResult {
    const entry = this.requireEntry();
    this.requireShims();
    if (!Number.isInteger(version) || version < 0 || version > UINT32_MAX) {
      throw new Error("SAP version must be an unsigned 32-bit integer");
    }
    if (input.length > UINT32_MAX) {
      throw new Error("SAP exchange input is too large");
    }

    const hardware = createHardwareBlock(hardwareId);
    this.beginCall();
    try {
      const hardwareAddress = this.scratch(hardware, hardware.length);
      const inputAddress = this.scratch(input, input.length);
      const outputField = this.scratch(undefined, 8);
      const lengthField = this.scratch(undefined, 8);
      const resultField = this.scratch(undefined, 4);

      const status = this.invoke(
        entry.exchange,
        BigInt(version),
        BigInt(hardwareAddress),
        contextValue,
        BigInt(inputAddress),
        BigInt(input.length),
        BigInt(outputField),
        BigInt(lengthField),
        BigInt(resultField),
      );
      const signedStatus = Number(BigInt.asIntN(32, status));
      if (signedStatus !== 0) {
        throw new Error(`SAP exchange returned ${signedStatus}`);
      }

      return {
        output: this.consumeOutput(outputField, lengthField),
        state: Number(BigInt.asIntN(32, BigInt(this.readUint32(resultField)))),
      };
    } finally {
      this.clearScratch();
    }
  }

  sign(contextValue: bigint, input: Uint8Array): Uint8Array {
    const entry = this.requireEntry();
    this.requireShims();
    if (input.length > UINT32_MAX) {
      throw new Error("SAP signing input is too large");
    }

    this.beginCall();
    try {
      const inputAddress = this.scratch(input, input.length);
      const outputField = this.scratch(undefined, 8);
      const lengthField = this.scratch(undefined, 8);
      const status = this.invoke(
        entry.sign,
        contextValue,
        BigInt(inputAddress),
        BigInt(input.length),
        BigInt(outputField),
        BigInt(lengthField),
      );
      const signedStatus = Number(BigInt.asIntN(32, status));
      if (signedStatus !== 0) {
        throw new Error(`SAP signing returned ${signedStatus}`);
      }

      return this.consumeOutput(outputField, lengthField);
    } finally {
      this.clearScratch();
    }
  }

  teardown(contextValue: bigint) {
    const entry = this.requireEntry();
    this.requireShims();
    const status = this.invoke(entry.teardown, contextValue);
    const signedStatus = Number(BigInt.asIntN(32, status));
    if (signedStatus !== 0) {
      throw new Error(`SAP teardown returned ${signedStatus}`);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.shims?.close();
    } finally {
      this.engine.close();
    }
  }

  private dispose(output: bigint) {
    const entry = this.requireEntry();
    const status = this.invoke(entry.dispose, output);
    const signedStatus = Number(BigInt.asIntN(32, status));
    if (signedStatus !== 0) {
      throw new Error(`SAP storage disposal returned ${signedStatus}`);
    }
  }

  private consumeOutput(pointerField: number, lengthField: number): Uint8Array {
    const pointer = this.readUint64(pointerField);
    const length = this.readUint64(lengthField);
    let output = new Uint8Array();
    let outputError: Error | undefined;

    try {
      if (length > BigInt(SAP_MAX_OUTPUT_SIZE)) {
        throw new Error(
          `SAP output is ${length.toString()} bytes, maximum is ${SAP_MAX_OUTPUT_SIZE}`,
        );
      }
      if (length === 0n) return output;
      if (pointer === 0n) {
        throw new Error("SAP returned a null output pointer");
      }

      output = this.engine.memRead(
        bigintToSafeNumber(pointer, "SAP output pointer"),
        Number(length),
      );
    } catch (error) {
      outputError = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (pointer !== 0n) {
        try {
          this.dispose(pointer);
        } catch (error) {
          const disposeError =
            error instanceof Error ? error : new Error(String(error));
          if (outputError) {
            throw new Error(
              `${outputError.message}; additionally failed to dispose SAP output: ${disposeError.message}`,
            );
          }
          throw disposeError;
        }
      }
    }

    if (outputError) throw outputError;
    return output;
  }

  private invoke(functionAddress: number, ...arguments_: bigint[]): bigint {
    if (this.closed) throw new Error("SAP guest machine is closed");
    if (!this.shims) throw new Error("SAP guest shim runtime is unavailable");
    if (functionAddress === 0) {
      throw new Error("SAP guest entry point is unavailable");
    }

    const registers = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"] as const;
    for (let index = 0; index < registers.length; index++) {
      this.engine.regWrite(registers[index], arguments_[index] ?? 0n);
    }

    const extra = Math.max(arguments_.length - registers.length, 0);
    let stackPointer = SAP_STACK_END - (extra + 1) * 8;
    if (stackPointer % 16 !== 8) stackPointer -= 8;
    this.writeUint64(stackPointer, BigInt(SAP_RETURN_ADDRESS));

    for (let index = 0; index < extra; index++) {
      this.writeUint64(
        stackPointer + 8 + index * 8,
        arguments_[registers.length + index],
      );
    }

    this.engine.regWrite("rsp", stackPointer);
    this.shims.resetFault();
    this.engine.clearDiagnosticStderr();
    const entryBytes = this.engine.memRead(functionAddress, 32);

    let lastBlockAddress: number | undefined;
    let lastBlockSize = 0;
    let timeoutError: Error | undefined;
    const deadline = performance.now() + SAP_EXECUTION_TIMEOUT_MS;
    const traceHook = this.engine.addBlockHook((address, size) => {
      lastBlockAddress = address;
      lastBlockSize = size;
      if (!timeoutError && performance.now() >= deadline) {
        timeoutError = new Error(
          `SAP guest execution exceeded ${SAP_EXECUTION_TIMEOUT_MS}ms browser limit`,
        );
        this.engine.stop();
      }
    });

    try {
      this.engine.startBrowserSafe(functionAddress, SAP_RETURN_ADDRESS);
    } catch (error) {
      const fault = this.shims.getFault();
      if (fault) throw fault;
      if (timeoutError) throw timeoutError;
      const message = error instanceof Error ? error.message : String(error);
      const stderr = this.engine.diagnosticStderr();
      throw new Error(
        `execute SAP guest function: ${message}; lastBlock=${describeGuestBlock(lastBlockAddress, lastBlockSize)}; entry32=${bytesToHex(entryBytes)}; unicornStderr=${formatStderr(stderr)}`,
      );
    } finally {
      try {
        traceHook.close();
      } catch {
        // A fatal Emscripten abort can invalidate hook cleanup. Preserve the
        // execution error and let machine.close perform best-effort cleanup.
      }
    }

    if (timeoutError) throw timeoutError;
    const fault = this.shims.getFault();
    if (fault) throw fault;

    const instruction = this.engine.regRead("rip");
    if (instruction !== BigInt(SAP_RETURN_ADDRESS)) {
      throw new Error(
        `SAP guest stopped unexpectedly at 0x${instruction.toString(16)}; lastBlock=${describeGuestBlock(lastBlockAddress, lastBlockSize)}`,
      );
    }

    return this.engine.regRead("rax");
  }

  private beginCall() {
    this.scratchCursor = 0;
  }

  private scratch(data: Uint8Array | undefined, size: number): number {
    const reserved = align(Math.max(size, 1), 16);
    if (this.scratchCursor + reserved > SAP_SCRATCH_SIZE) {
      throw new Error("SAP guest scratch space exhausted");
    }

    const address = SAP_SCRATCH_BASE + this.scratchCursor;
    this.scratchCursor += reserved;
    if (data && data.length !== 0) {
      if (data.length > size) {
        throw new Error("scratch data exceeds reservation");
      }
      this.engine.memWrite(address, data);
    } else if (size !== 0) {
      this.engine.memWrite(address, new Uint8Array(size));
    }
    return address;
  }

  private clearScratch() {
    if (this.scratchCursor !== 0 && !this.closed) {
      let offset = 0;
      const zero = new Uint8Array(64 << 10);
      while (offset < this.scratchCursor) {
        const count = Math.min(zero.length, this.scratchCursor - offset);
        this.engine.memWrite(
          SAP_SCRATCH_BASE + offset,
          count === zero.length ? zero : zero.subarray(0, count),
        );
        offset += count;
      }
    }
    this.scratchCursor = 0;
  }

  private readUint32(address: number): number {
    const data = this.engine.memRead(address, 4);
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
      0,
      true,
    );
  }

  private readUint64(address: number): bigint {
    const data = this.engine.memRead(address, 8);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return (
      BigInt(view.getUint32(0, true)) |
      (BigInt(view.getUint32(4, true)) << 32n)
    );
  }

  private writeUint64(address: number, value: bigint) {
    const normalized = BigInt.asUintN(64, value);
    const data = new Uint8Array(8);
    const view = new DataView(data.buffer);
    view.setUint32(0, Number(normalized & 0xffffffffn), true);
    view.setUint32(4, Number((normalized >> 32n) & 0xffffffffn), true);
    this.engine.memWrite(address, data);
  }

  private requireEntry(): BrowserSapEntryPoints {
    if (!this.entry) {
      throw new Error("SAP guest machine is not linked for execution");
    }
    return this.entry;
  }

  private requireShims(): BrowserSapShimTable {
    if (!this.shims) {
      throw new Error("SAP guest machine is not linked for execution");
    }
    return this.shims;
  }
}

function createBaseEngine(module: UnicornX86Module): BrowserUnicornEngine {
  const engine = new BrowserUnicornEngine(module);

  try {
    engine.memMap(SAP_RETURN_ADDRESS, SAP_PAGE_SIZE);
    engine.memMap(SAP_SHIM_BASE, SAP_SHIM_SIZE);
    engine.memMap(SAP_SCRATCH_BASE, SAP_SCRATCH_SIZE);
    engine.memMap(SAP_HEAP_BASE, SAP_HEAP_SIZE);
    engine.memMap(SAP_STACK_BASE, SAP_STACK_SIZE);

    engine.memWrite(SAP_RETURN_ADDRESS, new Uint8Array([0xf4]));
    return engine;
  } catch (error) {
    engine.close();
    throw error;
  }
}

function createHardwareBlock(hardwareId: Uint8Array): Uint8Array {
  if (hardwareId.length === 0 || hardwareId.length > 20) {
    throw new Error("hardware ID must contain between 1 and 20 bytes");
  }

  const hardware = new Uint8Array(24);
  new DataView(hardware.buffer).setUint32(0, hardwareId.length, true);
  hardware.set(hardwareId, 4);
  return hardware;
}

function bigintToSafeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

function describeGuestBlock(address: number | undefined, size: number): string {
  if (address === undefined) return "unavailable";

  const regions = [
    ["CoreFP", SAP_CORE_FP_BASE, SAP_COMMERCE_BASE],
    ["CommerceCore", SAP_COMMERCE_BASE, SAP_KIT_BASE],
    ["CommerceKit", SAP_KIT_BASE, SAP_SHIM_BASE],
    ["shim", SAP_SHIM_BASE, SAP_SCRATCH_BASE],
  ] as const;

  for (const [name, start, end] of regions) {
    if (address >= start && address < end) {
      return `${name}+0x${(address - start).toString(16)}(addr=0x${address.toString(16)},size=${size})`;
    }
  }

  return `0x${address.toString(16)}(size=${size})`;
}

function bytesToHex(input: Uint8Array): string {
  return Array.from(input, (value) => value.toString(16).padStart(2, "0")).join("");
}

function formatStderr(lines: string[]): string {
  if (lines.length === 0) return "none";
  return lines
    .slice(-8)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ");
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
