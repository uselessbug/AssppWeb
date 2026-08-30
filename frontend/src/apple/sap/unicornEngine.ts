import type {
  UnicornEngine as RawUnicornEngine,
  UnicornHook,
  UnicornX86Module,
} from "./unicornRuntime";

export const SAP_RETURN_ADDRESS = 0x0000000100000000;
export const SAP_CORE_FP_BASE = 0x0000100000000000;
export const SAP_COMMERCE_BASE = 0x0000100040000000;
export const SAP_KIT_BASE = 0x0000100080000000;
export const SAP_SHIM_BASE = 0x0000200000000000;
export const SAP_SCRATCH_BASE = 0x0000300000000000;
export const SAP_HEAP_BASE = 0x0000400000000000;
export const SAP_STACK_BASE = 0x0000500000000000;

export const SAP_PAGE_SIZE = 0x1000;
export const SAP_SCRATCH_SIZE = 32 << 20;
export const SAP_HEAP_SIZE = 64 << 20;
export const SAP_STACK_SIZE = 8 << 20;
export const SAP_STACK_END = SAP_STACK_BASE + SAP_STACK_SIZE;

const X86_REG_RFLAGS = 253;

interface WasmTableFault {
  index: number;
  tableLength: number;
  functionName: string;
  functionArity: number;
  arguments: string[];
  message: string;
  stack: string;
}

interface TableGetPrototype {
  get(index: number): unknown;
}

let wasmTableDiagnosticsInstalled = false;
let lastWasmTableFault: WasmTableFault | undefined;
const wasmTableWrappers = new WeakMap<
  object,
  Map<number, (...arguments_: unknown[]) => unknown>
>();

export type SapRegister =
  | "rax"
  | "rdi"
  | "rsi"
  | "rdx"
  | "rcx"
  | "r8"
  | "r9"
  | "rip"
  | "rsp"
  | "rflags";

export type CodeHookHandler = (address: number, size: number) => void;

export class BrowserUnicornCodeHook {
  private closed = false;

  constructor(
    private readonly engine: RawUnicornEngine,
    private readonly hook?: UnicornHook,
  ) {}

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.hook) this.engine.hook_del(this.hook);
  }
}

export class BrowserUnicornEngine {
  private readonly engine: RawUnicornEngine;
  private closed = false;

  constructor(private readonly module: UnicornX86Module) {
    installWasmTableDiagnostics();
    this.engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  }

  memMap(address: number, size: number) {
    this.assertOpen();
    this.assertSafeRange(address, size);
    this.engine.mem_map(address, size, this.module.PROT_ALL);
  }

  memWrite(address: number, data: Uint8Array) {
    this.assertOpen();
    this.assertSafeRange(address, data.length);
    this.engine.mem_write(address, data);
  }

  memRead(address: number, size: number): Uint8Array {
    this.assertOpen();
    this.assertSafeRange(address, size);
    return this.engine.mem_read(address, size);
  }

  regWrite(register: SapRegister, value: bigint | number) {
    this.assertOpen();
    const normalized = typeof value === "bigint" ? value : BigInt(value);
    this.engine.reg_write_i64(this.registerId(register), normalized);
  }

  regRead(register: SapRegister): bigint {
    this.assertOpen();
    return this.engine.reg_read_i64(this.registerId(register));
  }

  addCodeHook(
    begin: number,
    end: number,
    handler: CodeHookHandler,
  ): BrowserUnicornCodeHook {
    this.assertOpen();
    this.assertSafeRange(begin, Math.max(0, end - begin));
    return this.addHook(this.module.HOOK_CODE, handler, begin, end);
  }

  addBlockHook(_handler: CodeHookHandler): BrowserUnicornCodeHook {
    this.assertOpen();

    // Real SAP execution currently runs without UC_HOOK_BLOCK. The recurring
    // browser failure is an Emscripten indirect-table trap, and block hooks are
    // themselves host function pointers invoked through that table. Keep the
    // raw Unicorn hook smoke test in unicornRuntime.ts, but remove this global
    // per-basic-block callback from the Apple guest until the failure source is
    // separated from guest/TCI execution.
    return new BrowserUnicornCodeHook(this.engine);
  }

  startBrowserSafe(begin: number, until: number) {
    this.assertOpen();
    this.assertSafeRange(begin, 0);
    this.assertSafeRange(until, 0);

    // A non-zero Unicorn timeout creates a QEMU timer thread, and a non-zero
    // instruction count installs hook_count_cb. Both paths are unsafe in this
    // single-threaded browser/TCI build, so browser SAP currently uses neither.
    // A production wall-clock bound should live outside Unicorn in a Worker.
    this.engine.emu_start(begin, until, 0, 0);
  }

  stop() {
    this.assertOpen();
    this.engine.emu_stop();
  }

  diagnosticStderr(): string[] {
    const lines = [...(this.module.__assppStderr ?? [])];
    if (lastWasmTableFault) {
      lines.push(formatWasmTableFault(lastWasmTableFault));
    }
    return lines;
  }

  clearDiagnosticStderr() {
    if (this.module.__assppStderr) this.module.__assppStderr.length = 0;
    lastWasmTableFault = undefined;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.engine.close();
  }

  private addHook(
    type: number,
    handler: CodeHookHandler,
    begin?: number,
    end?: number,
  ): BrowserUnicornCodeHook {
    const hook = this.engine.hook_add(
      type,
      (_engine: unknown, address: bigint | number, size: number) => {
        const numericAddress = Number(address);
        if (!Number.isSafeInteger(numericAddress)) {
          try {
            this.engine.emu_stop();
          } finally {
            throw new Error("Unicorn hook returned an unsafe guest address");
          }
        }
        handler(numericAddress, size);
      },
      undefined,
      begin,
      end,
    );

    return new BrowserUnicornCodeHook(this.engine, hook);
  }

  private registerId(register: SapRegister): number {
    switch (register) {
      case "rax":
        return this.module.X86_REG_RAX;
      case "rdi":
        return this.module.X86_REG_RDI;
      case "rsi":
        return this.module.X86_REG_RSI;
      case "rdx":
        return this.module.X86_REG_RDX;
      case "rcx":
        return this.module.X86_REG_RCX;
      case "r8":
        return this.module.X86_REG_R8;
      case "r9":
        return this.module.X86_REG_R9;
      case "rip":
        return this.module.X86_REG_RIP;
      case "rsp":
        return this.module.X86_REG_RSP;
      case "rflags":
        return X86_REG_RFLAGS;
    }
  }

  private assertOpen() {
    if (this.closed) {
      throw new Error("SAP Unicorn engine is closed");
    }
  }

  private assertSafeRange(address: number, size: number) {
    if (
      !Number.isSafeInteger(address) ||
      !Number.isSafeInteger(size) ||
      address < 0 ||
      size < 0 ||
      !Number.isSafeInteger(address + size)
    ) {
      throw new Error("SAP guest memory range exceeds JavaScript safe integers");
    }
  }
}

function installWasmTableDiagnostics() {
  if (wasmTableDiagnosticsInstalled || typeof WebAssembly === "undefined") {
    return;
  }
  wasmTableDiagnosticsInstalled = true;

  const prototype = WebAssembly.Table.prototype as unknown as TableGetPrototype;
  const originalGet = prototype.get;

  try {
    prototype.get = function (this: WebAssembly.Table, index: number): unknown {
      const original = originalGet.call(this, index);
      if (typeof original !== "function") return original;

      const acquisitionStack = new Error().stack ?? "";
      if (
        acquisitionStack !== "" &&
        !acquisitionStack.includes("getWasmTableEntry") &&
        !acquisitionStack.includes("unicorn_x86")
      ) {
        return original;
      }

      let wrappers = wasmTableWrappers.get(this);
      if (!wrappers) {
        wrappers = new Map();
        wasmTableWrappers.set(this, wrappers);
      }

      const existing = wrappers.get(index);
      if (existing) return existing;

      const originalFunction = original as (...arguments_: unknown[]) => unknown;
      const wrapped = (...arguments_: unknown[]): unknown => {
        try {
          return originalFunction(...arguments_);
        } catch (error) {
          lastWasmTableFault = {
            index,
            tableLength: this.length,
            functionName: originalFunction.name || "anonymous",
            functionArity: originalFunction.length,
            arguments: arguments_.map(formatWasmArgument),
            message: error instanceof Error ? error.message : String(error),
            stack: formatStack(error),
          };
          throw error;
        }
      };

      wrappers.set(index, wrapped);
      return wrapped;
    };
  } catch {
    // Some engines may expose WebAssembly.Table.prototype.get as immutable.
    // The emulator remains usable; only this diagnostic will be unavailable.
  }
}

function formatWasmArgument(value: unknown): string {
  if (typeof value === "bigint") {
    return `0x${BigInt.asUintN(64, value).toString(16)}`;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return `0x${BigInt.asUintN(32, BigInt(value)).toString(16)}(${value})`;
  }
  return String(value);
}

function formatWasmTableFault(fault: WasmTableFault): string {
  return `wasmTableFault: index=${fault.index}/${fault.tableLength}, function=${fault.functionName}, arity=${fault.functionArity}, args=[${fault.arguments.join(",")}], error=${fault.message}, stack=${fault.stack}`;
}

function formatStack(error: unknown): string {
  const stack = error instanceof Error ? error.stack : new Error().stack;
  if (!stack) return "unavailable";
  return stack
    .split("\n")
    .slice(0, 8)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" <- ");
}
