import {
  BrowserUnicornEngine,
  SAP_HEAP_BASE,
  SAP_HEAP_SIZE,
  SAP_PAGE_SIZE,
  SAP_RETURN_ADDRESS,
  SAP_SCRATCH_BASE,
  SAP_SCRATCH_SIZE,
  SAP_SHIM_BASE,
  SAP_STACK_BASE,
  SAP_STACK_SIZE,
} from "./unicornEngine";
import type { UnicornX86Module } from "./unicornRuntime";

const SAP_SHIM_SIZE = 0x00100000;

export class BrowserSapMachine {
  private closed = false;

  private constructor(private readonly engine: BrowserUnicornEngine) {}

  static open(module: UnicornX86Module): BrowserSapMachine {
    const engine = new BrowserUnicornEngine(module);

    try {
      engine.memMap(SAP_RETURN_ADDRESS, SAP_PAGE_SIZE);
      engine.memMap(SAP_SHIM_BASE, SAP_SHIM_SIZE);
      engine.memMap(SAP_SCRATCH_BASE, SAP_SCRATCH_SIZE);
      engine.memMap(SAP_HEAP_BASE, SAP_HEAP_SIZE);
      engine.memMap(SAP_STACK_BASE, SAP_STACK_SIZE);

      // ipatool places HLT at the synthetic return address so a guest function
      // cannot silently continue into unmapped memory after returning.
      engine.memWrite(SAP_RETURN_ADDRESS, new Uint8Array([0xf4]));

      return new BrowserSapMachine(engine);
    } catch (error) {
      engine.close();
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.engine.close();
  }
}
