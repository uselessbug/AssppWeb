import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  SAP_ASSET_SPECS,
  validateSapAssetBundle,
  type AppleSapAssetBundle,
  type SapAssetSpec,
} from "./cpio";

const DB_NAME = "asspp-sap-assets";
const DB_VERSION = 1;
const STORE_NAME = "assets";
const CACHE_VERSION = `apple-assets-v2:${SAP_ASSET_SPECS.map((spec) => spec.sha256).join(":")}`;

type SapAssetName = SapAssetSpec["name"];

interface CachedSapAsset {
  key: string;
  version: string;
  name: SapAssetName;
  size: number;
  sha256: string;
  data: Blob;
}

interface SapAssetCacheDB extends DBSchema {
  assets: {
    key: string;
    value: CachedSapAsset;
  };
}

let dbPromise: Promise<IDBPDatabase<SapAssetCacheDB>> | undefined;

export async function readCachedAppleSapAssets(): Promise<AppleSapAssetBundle | undefined> {
  const db = await getDB();
  const records = await Promise.all(
    SAP_ASSET_SPECS.map((spec) => db.get(STORE_NAME, cacheKey(spec.name))),
  );

  if (records.some((record) => record === undefined)) return undefined;

  const files = new Map<SapAssetName, Uint8Array>();
  for (let index = 0; index < SAP_ASSET_SPECS.length; index++) {
    const spec = SAP_ASSET_SPECS[index];
    const record = records[index]!;
    if (
      record.version !== CACHE_VERSION ||
      record.name !== spec.name ||
      record.size !== spec.size ||
      record.sha256 !== spec.sha256 ||
      record.data.size !== spec.size
    ) {
      await clearAppleSapAssetCache();
      return undefined;
    }

    files.set(spec.name, new Uint8Array(await record.data.arrayBuffer()));
  }

  const bundle = bundleFromFiles(files);
  try {
    await validateSapAssetBundle(bundle);
    return bundle;
  } catch {
    await clearAppleSapAssetCache();
    return undefined;
  }
}

export async function writeCachedAppleSapAssets(bundle: AppleSapAssetBundle): Promise<void> {
  await validateSapAssetBundle(bundle);

  const files = bundleFiles(bundle);
  const db = await getDB();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  await transaction.store.clear();

  for (const spec of SAP_ASSET_SPECS) {
    const data = files[spec.name];
    await transaction.store.put({
      key: cacheKey(spec.name),
      version: CACHE_VERSION,
      name: spec.name,
      size: spec.size,
      sha256: spec.sha256,
      data: new Blob([data], { type: "application/octet-stream" }),
    });
  }

  await transaction.done;
}

export async function clearAppleSapAssetCache(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE_NAME);
}

function getDB(): Promise<IDBPDatabase<SapAssetCacheDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SapAssetCacheDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      },
    });
  }

  return dbPromise;
}

function cacheKey(name: SapAssetName): string {
  return `${CACHE_VERSION}:${name}`;
}

function bundleFiles(bundle: AppleSapAssetBundle): Record<SapAssetName, Uint8Array> {
  return {
    CommerceKit: bundle.CommerceKit,
    CommerceCore: bundle.CommerceCore,
    CoreFP: bundle.CoreFP,
    "CoreFP.icxs": bundle.CoreFPICXS,
  };
}

function bundleFromFiles(files: Map<SapAssetName, Uint8Array>): AppleSapAssetBundle {
  const commerceKit = files.get("CommerceKit");
  const commerceCore = files.get("CommerceCore");
  const coreFP = files.get("CoreFP");
  const coreFPICXS = files.get("CoreFP.icxs");
  if (!commerceKit || !commerceCore || !coreFP || !coreFPICXS) {
    throw new Error("Apple SAP asset cache is incomplete");
  }

  return {
    CommerceKit: commerceKit,
    CommerceCore: commerceCore,
    CoreFP: coreFP,
    CoreFPICXS: coreFPICXS,
  };
}
