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

export type SapRegister =
  | "rax"
  | "rdi"
  | "rsi"
  | "rdx"
  | "rcx"
  | "r8"
  | "r9"
  | "rip"
  | "rsp";

export type CodeHookHandler = (address: number, size: number) => void;

export class BrowserUnicornCodeHook {
  private closed = false;

  constructor(
    private readonly engine: RawUnicornEngine,
    private readonly hook: UnicornHook,
  ) {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.engine.hook_del(this.hook);
  }
}

export class BrowserUnicornEngine {
  private readonly engine: RawUnicornEngine;
  private closed = false;

  constructor(private readonly module: UnicornX86Module) {
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

  addBlockHook(handler: CodeHookHandler): BrowserUnicornCodeHook {
    this.assertOpen();
    return this.addHook(this.module.HOOK_BLOCK, handler);
  }

  startBounded(
    begin: number,
    until: number,
    timeoutMs = 10_000,
    instructionCount = 100_000_000,
  ) {
    this.assertOpen();
    this.assertSafeRange(begin, 0);
    this.assertSafeRange(until, 0);

    this.engine.emu_start(
      begin,
      until,
      timeoutMs * 1000,
      instructionCount,
    );
  }

  stop() {
    this.assertOpen();
    this.engine.emu_stop();
  }

  diagnosticStderr(): string[] {
    return [...(this.module.__assppStderr ?? [])];
  }

  clearDiagnosticStderr() {
    if (this.module.__assppStderr) this.module.__assppStderr.length = 0;
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
