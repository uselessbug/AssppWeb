import { BrowserUnicornEngine, SAP_SHIM_BASE } from "./unicornEngine";

const SHIM_CODE_SIZE = 0x00080000;
const SHIM_SLOT_SIZE = 16;
const SHIM_RET = 0xc3;

export interface SapShimSummary {
  imports: number;
  firstAddress: number;
  lastAddress: number;
}

export class BrowserSapShimTable {
  private readonly addresses = new Map<string, number>();
  private nextOffset = 0;

  constructor(private readonly engine: BrowserUnicornEngine) {}

  resolve(name: string): number {
    const existing = this.addresses.get(name);
    if (existing !== undefined) return existing;

    if (!name) throw new Error("SAP guest import name is empty");
    if (this.nextOffset + SHIM_SLOT_SIZE > SHIM_CODE_SIZE) {
      throw new Error("SAP shim code area is exhausted");
    }

    const address = SAP_SHIM_BASE + this.nextOffset;
    this.nextOffset += SHIM_SLOT_SIZE;

    const stub = new Uint8Array(SHIM_SLOT_SIZE);
    stub[0] = SHIM_RET;
    this.engine.memWrite(address, stub);
    this.addresses.set(name, address);
    return address;
  }

  summary(): SapShimSummary {
    const imports = this.addresses.size;
    return {
      imports,
      firstAddress: imports === 0 ? SAP_SHIM_BASE : SAP_SHIM_BASE,
      lastAddress:
        imports === 0
          ? SAP_SHIM_BASE
          : SAP_SHIM_BASE + (imports - 1) * SHIM_SLOT_SIZE,
    };
  }

  names(): string[] {
    return Array.from(this.addresses.keys()).sort();
  }
}
