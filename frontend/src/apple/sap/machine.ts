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
  SAP_STACK_SIZE,
} from "./unicornEngine";
import type { UnicornX86Module } from "./unicornRuntime";

const SAP_SHIM_SIZE = 0x00100000;

export interface BrowserSapLinkSummary {
  coreFP: ReturnType<BrowserMachODyldImage["summary"]>;
  commerceCore: ReturnType<BrowserMachODyldImage["summary"]>;
  commerceKit: ReturnType<BrowserMachODyldImage["summary"]>;
  shimImports: number;
  shimNames: string[];
}

export class BrowserSapMachine {
  private closed = false;

  private constructor(
    private readonly engine: BrowserUnicornEngine,
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

      const coreFP = BrowserMachODyldImage.open("CoreFP", bundle.CoreFP);
      const commerceCore = BrowserMachODyldImage.open(
        "CommerceCore",
        bundle.CommerceCore,
      );
      const commerceKit = BrowserMachODyldImage.open(
        "CommerceKit",
        bundle.CommerceKit,
      );
      const shims = new BrowserSapShimTable(engine);

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

        return shims.resolve(name);
      };

      coreFP.relocate(SAP_CORE_FP_BASE, resolve);
      commerceCore.relocate(SAP_COMMERCE_BASE, resolve);
      commerceKit.relocate(SAP_KIT_BASE, resolve);

      coreFP.load(engine);
      commerceCore.load(engine);
      commerceKit.load(engine);

      const shimSummary = shims.summary();
      return new BrowserSapMachine(engine, {
        coreFP: coreFP.summary(),
        commerceCore: commerceCore.summary(),
        commerceKit: commerceKit.summary(),
        shimImports: shimSummary.imports,
        shimNames: shims.names(),
      });
    } catch (error) {
      engine.close();
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

  close() {
    if (this.closed) return;
    this.closed = true;
    this.engine.close();
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
