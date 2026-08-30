import { initLibcurl, libcurl } from "../libcurl-init";

const APPLE_SAP_UPDATE_URL =
  "https://swcdn.apple.com/content/downloads/27/34/041-98128-A_SYPWICN3KH/5dqkl4rqgbsr18yzy61yeie9g3cmjc5hiv/OSXUpd10.9.pkg";
const XAR_MAGIC = 0x78617221;
const XAR_VERSION = 1;
const XAR_HEADER_SIZE = 28;
const MAX_XAR_TOC_COMPRESSED_SIZE = 16 << 20;
const MAX_XAR_TOC_PLAIN_SIZE = 64 << 20;
const PAYLOAD_BZIP_OFFSET = 0x352f40d5;
const PAYLOAD_CPIO_OFFSET = 0x3a4;
const BZIP_PROBE_SIZE = 16;

export interface XarHeader {
  headerSize: number;
  version: number;
  tocCompressedLength: number;
  tocPlainLength: number;
  checksumKind: number;
}

export interface XarPayloadLocation {
  heapOffset: number;
  payloadOffset: number;
  payloadLength: number;
  payloadSize: number;
  payloadEncoding: string;
}

export interface AppleSapAssetProbe {
  updateURL: string;
  tocCompressedLength: number;
  tocPlainLength: number;
  payloadOffset: number;
  payloadLength: number;
  payloadSize: number;
  bzipStreamOffset: number;
  cpioSkip: number;
  bzipProbeHex: string;
}

export async function inspectAppleSapPackage(): Promise<AppleSapAssetProbe> {
  const headerBytes = await fetchAppleRange(0, XAR_HEADER_SIZE - 1);
  const header = parseXarHeader(headerBytes);
  const tocStart = header.headerSize;
  const tocEnd = tocStart + header.tocCompressedLength - 1;
  const compressedToc = await fetchAppleRange(tocStart, tocEnd);
  const plainToc = await inflateXarToc(compressedToc, header.tocPlainLength);
  const location = parsePayloadLocation(plainToc, header);

  const bzipStreamOffset = checkedAdd(
    location.payloadOffset,
    PAYLOAD_BZIP_OFFSET,
    "Apple SAP bzip stream offset",
  );
  const payloadEnd = checkedAdd(
    location.payloadOffset,
    location.payloadLength,
    "Apple SAP payload end",
  );
  if (bzipStreamOffset >= payloadEnd) {
    throw new Error("Apple SAP bzip stream starts outside the XAR Payload");
  }

  const probeEnd = Math.min(
    payloadEnd - 1,
    bzipStreamOffset + BZIP_PROBE_SIZE - 1,
  );
  const probe = await fetchAppleRange(bzipStreamOffset, probeEnd);

  return {
    updateURL: APPLE_SAP_UPDATE_URL,
    tocCompressedLength: header.tocCompressedLength,
    tocPlainLength: header.tocPlainLength,
    payloadOffset: location.payloadOffset,
    payloadLength: location.payloadLength,
    payloadSize: location.payloadSize,
    bzipStreamOffset,
    cpioSkip: PAYLOAD_CPIO_OFFSET,
    bzipProbeHex: bytesToHex(probe),
  };
}

export function parseXarHeader(input: Uint8Array): XarHeader {
  if (input.length !== XAR_HEADER_SIZE) {
    throw new Error(
      `Apple SAP XAR header has ${input.length} bytes, expected ${XAR_HEADER_SIZE}`,
    );
  }

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== XAR_MAGIC) {
    throw new Error(`Apple SAP package has invalid XAR magic 0x${magic.toString(16)}`);
  }

  const headerSize = view.getUint16(4, false);
  if (headerSize !== XAR_HEADER_SIZE) {
    throw new Error(
      `Apple SAP XAR header size is ${headerSize}, expected ${XAR_HEADER_SIZE}`,
    );
  }

  const version = view.getUint16(6, false);
  if (version !== XAR_VERSION) {
    throw new Error(`Apple SAP XAR version ${version} is unsupported`);
  }

  const tocCompressedLength = readSafeUint64(view, 8, "compressed XAR TOC");
  const tocPlainLength = readSafeUint64(view, 16, "plain XAR TOC");
  if (
    tocCompressedLength <= 0 ||
    tocCompressedLength > MAX_XAR_TOC_COMPRESSED_SIZE
  ) {
    throw new Error(
      `Apple SAP compressed XAR TOC size ${tocCompressedLength} is outside the allowed range`,
    );
  }
  if (tocPlainLength <= 0 || tocPlainLength > MAX_XAR_TOC_PLAIN_SIZE) {
    throw new Error(
      `Apple SAP plain XAR TOC size ${tocPlainLength} is outside the allowed range`,
    );
  }

  return {
    headerSize,
    version,
    tocCompressedLength,
    tocPlainLength,
    checksumKind: view.getUint32(24, false),
  };
}

export function parsePayloadLocation(
  plainToc: Uint8Array,
  header: XarHeader,
): XarPayloadLocation {
  if (typeof DOMParser === "undefined") {
    throw new Error("Apple SAP XAR parsing requires DOMParser");
  }

  const text = new TextDecoder().decode(plainToc);
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length !== 0) {
    throw new Error("Apple SAP XAR TOC XML could not be parsed");
  }

  for (const file of Array.from(document.getElementsByTagName("file"))) {
    if (directChildText(file, "name") !== "Payload") continue;

    const data = directChild(file, "data");
    if (!data) {
      throw new Error("Apple SAP XAR Payload entry has no data element");
    }

    const offset = parseSafeDecimal(
      directChildText(data, "offset"),
      "Apple SAP Payload offset",
    );
    const length = parseSafeDecimal(
      directChildText(data, "length"),
      "Apple SAP Payload length",
    );
    const size = parseSafeDecimal(
      directChildText(data, "size"),
      "Apple SAP Payload size",
    );
    const encoding = directChild(data, "encoding")?.getAttribute("style") ?? "";
    const heapOffset = checkedAdd(
      header.headerSize,
      header.tocCompressedLength,
      "Apple SAP XAR heap offset",
    );

    return {
      heapOffset,
      payloadOffset: checkedAdd(
        heapOffset,
        offset,
        "Apple SAP absolute Payload offset",
      ),
      payloadLength: length,
      payloadSize: size,
      payloadEncoding: encoding,
    };
  }

  throw new Error("Apple SAP XAR TOC does not contain Payload");
}

async function inflateXarToc(
  compressed: Uint8Array,
  expectedLength: number,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This Safari version does not provide DecompressionStream required for the Apple SAP XAR TOC",
    );
  }

  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const plain = new Uint8Array(await new Response(stream).arrayBuffer());
  if (plain.length !== expectedLength) {
    throw new Error(
      `Apple SAP XAR TOC inflated to ${plain.length} bytes, expected ${expectedLength}`,
    );
  }

  return plain;
}

async function fetchAppleRange(start: number, end: number): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw new Error(`Invalid Apple SAP byte range ${start}-${end}`);
  }

  await initLibcurl();
  const response = await libcurl.fetch(APPLE_SAP_UPDATE_URL, {
    method: "GET",
    headers: {
      Accept: "application/octet-stream",
      Range: `bytes=${start}-${end}`,
    },
    redirect: "manual",
    _libcurl_http_version: 1.1,
  });

  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(
      `Apple SAP Range request returned HTTP ${response.status}, expected 206`,
    );
  }

  const contentRange = response.headers.get("content-range");
  if (!contentRange) {
    await response.body?.cancel();
    throw new Error("Apple SAP Range response is missing Content-Range");
  }
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim());
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end) {
    await response.body?.cancel();
    throw new Error(
      `Apple SAP Range response did not match requested bytes ${start}-${end}: ${contentRange}`,
    );
  }

  const body = new Uint8Array(await response.arrayBuffer());
  const expectedLength = end - start + 1;
  if (body.length !== expectedLength) {
    throw new Error(
      `Apple SAP Range response has ${body.length} bytes, expected ${expectedLength}`,
    );
  }

  return body;
}

function readSafeUint64(view: DataView, offset: number, label: string): number {
  const high = BigInt(view.getUint32(offset, false));
  const low = BigInt(view.getUint32(offset + 4, false));
  const value = (high << 32n) | low;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }

  return Number(value);
}

function parseSafeDecimal(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} is not an unsigned decimal integer`);
  }

  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }

  return Number(parsed);
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }

  return result;
}

function directChild(element: Element, tagName: string): Element | undefined {
  return Array.from(element.children).find((child) => child.tagName === tagName);
}

function directChildText(element: Element, tagName: string): string {
  return directChild(element, tagName)?.textContent?.trim() ?? "";
}

function bytesToHex(input: Uint8Array): string {
  return Array.from(input, (value) => value.toString(16).padStart(2, "0")).join("");
}
