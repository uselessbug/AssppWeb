import { initLibcurl, libcurl } from "../libcurl-init";
import { inspectAppleSapPackage } from "./assets";
import { Bzip2NeedMoreData, decodeBzip2Block } from "./bzip2";
import {
  SapCpioCollector,
  validateSapAssetBundle,
  type AppleSapAssetBundle,
} from "./cpio";

const APPLE_SAP_UPDATE_URL =
  "https://swcdn.apple.com/content/downloads/27/34/041-98128-A_SYPWICN3KH/5dqkl4rqgbsr18yzy61yeie9g3cmjc5hiv/OSXUpd10.9.pkg";
const CPIO_PREFIX_BYTES = 0x3a4;
const DECODE_BUFFER_TARGET = 2 << 20;

export interface AppleSapExtractionResult {
  bundle: AppleSapAssetBundle;
  compressedBytesRead: number;
  decompressedBytesRead: number;
  blocksDecoded: number;
}

export async function extractAppleSapAssets(): Promise<AppleSapExtractionResult> {
  const probe = await inspectAppleSapPackage();
  const payloadEnd = probe.payloadOffset + probe.payloadLength;
  if (!Number.isSafeInteger(payloadEnd) || probe.bzipStreamOffset >= payloadEnd) {
    throw new Error("Apple SAP Payload range is invalid");
  }

  await initLibcurl();
  const rangeEnd = payloadEnd - 1;
  const response = await libcurl.fetch(APPLE_SAP_UPDATE_URL, {
    method: "GET",
    headers: {
      Accept: "application/octet-stream",
      Range: `bytes=${probe.bzipStreamOffset}-${rangeEnd}`,
    },
    redirect: "manual",
    _libcurl_http_version: 1.1,
  });

  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(
      `Apple SAP streaming Range request returned HTTP ${response.status}, expected 206`,
    );
  }
  const contentRange = response.headers.get("content-range");
  const expectedRange = `bytes ${probe.bzipStreamOffset}-${rangeEnd}/`;
  if (!contentRange?.toLowerCase().startsWith(expectedRange.toLowerCase())) {
    await response.body?.cancel();
    throw new Error(
      `Apple SAP streaming Range response has unexpected Content-Range: ${contentRange ?? "missing"}`,
    );
  }
  if (!response.body) {
    throw new Error("Apple SAP streaming Range response has no body");
  }

  const reader = response.body.getReader();
  const collector = new SapCpioCollector(CPIO_PREFIX_BYTES);
  let compressed = new Uint8Array();
  let startBit = 0;
  let compressedBytesRead = 0;
  let decompressedBytesRead = 0;
  let blocksDecoded = 0;
  let networkDone = false;

  try {
    while (!collector.complete) {
      while (!networkDone && compressed.length < DECODE_BUFFER_TARGET) {
        const item = await reader.read();
        if (item.done) {
          networkDone = true;
          break;
        }
        const chunk = toUint8Array(item.value);
        compressedBytesRead += chunk.length;
        compressed = appendBytes(compressed, chunk);
      }

      if (compressed.length === 0 && networkDone) {
        break;
      }

      let decodedAny = false;
      while (!collector.complete) {
        try {
          const result = decodeBzip2Block(
            compressed,
            startBit,
            (chunk) => collector.feed(chunk),
          );
          decodedAny = true;
          decompressedBytesRead += result.outputBytes;

          if (result.endOfStream) {
            networkDone = true;
            compressed = new Uint8Array();
            startBit = 0;
            break;
          }

          blocksDecoded++;
          const consumedBytes = Math.floor(result.nextBit / 8);
          compressed = compressed.slice(consumedBytes);
          startBit = result.nextBit - consumedBytes * 8;

          if (compressed.length < DECODE_BUFFER_TARGET && !networkDone) {
            break;
          }
        } catch (error) {
          if (error instanceof Bzip2NeedMoreData && !networkDone) {
            break;
          }
          throw error;
        }
      }

      if (collector.complete) break;
      if (networkDone) {
        if (!decodedAny && compressed.length !== 0) {
          throw new Error("Apple SAP bzip2 stream ended in the middle of a block");
        }
        if (compressed.length === 0) break;
      }
    }
  } finally {
    if (collector.complete) {
      try {
        await reader.cancel("required Apple SAP assets extracted");
      } catch {
        // The libcurl-backed stream may already be closed after the final chunk.
      }
    }
  }

  const bundle = collector.finish();
  await validateSapAssetBundle(bundle);

  return {
    bundle,
    compressedBytesRead,
    decompressedBytesRead,
    blocksDecoded,
  };
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left;
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Apple SAP stream returned an unsupported binary chunk");
}
