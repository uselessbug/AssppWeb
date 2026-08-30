import { extractAppleSapAssets } from "./assetExtractor";
import {
  readCachedAppleSapAssets,
  writeCachedAppleSapAssets,
} from "./assetCache";
import type { AppleSapAssetBundle } from "./cpio";

export interface AppleSapAssetLoadResult {
  bundle: AppleSapAssetBundle;
  source: "memory" | "indexeddb" | "network";
  compressedBytesRead: number;
  decompressedBytesRead: number;
  blocksDecoded: number;
}

let memoryBundle: AppleSapAssetBundle | undefined;
let loadPromise: Promise<AppleSapAssetLoadResult> | undefined;

export function loadAppleSapAssets(): Promise<AppleSapAssetLoadResult> {
  if (memoryBundle) {
    return Promise.resolve({
      bundle: memoryBundle,
      source: "memory",
      compressedBytesRead: 0,
      decompressedBytesRead: 0,
      blocksDecoded: 0,
    });
  }

  if (!loadPromise) {
    loadPromise = loadAppleSapAssetsUncached().finally(() => {
      loadPromise = undefined;
    });
  }

  return loadPromise;
}

async function loadAppleSapAssetsUncached(): Promise<AppleSapAssetLoadResult> {
  const cached = await readCachedAppleSapAssets();
  if (cached) {
    memoryBundle = cached;
    return {
      bundle: cached,
      source: "indexeddb",
      compressedBytesRead: 0,
      decompressedBytesRead: 0,
      blocksDecoded: 0,
    };
  }

  const extraction = await extractAppleSapAssets();
  memoryBundle = extraction.bundle;

  try {
    await writeCachedAppleSapAssets(extraction.bundle);
  } catch (error) {
    console.warn("Failed to persist verified Apple SAP assets", error);
  }

  return {
    ...extraction,
    source: "network",
  };
}
