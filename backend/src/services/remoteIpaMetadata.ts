import { inflateRawSync } from 'zlib';
import bplistParser from 'bplist-parser';
import plist from 'plist';

export interface RemoteIpaVersionMetadata {
  displayVersion: string;
  releaseDate: string;
}

interface ZipEntry {
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
  modifiedAt: Date | null;
}

interface CentralDirectoryLocation {
  offset: number;
  size: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const ZIP64_EOCD_MIN_SIZE = 56;
const ZIP64_EOCD_LOCATOR_SIZE = 20;
const MAX_EOCD_SIZE = 65_577;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function bigintToSafeNumber(value: bigint, label: string): number {
  if (value > MAX_SAFE_BIGINT) {
    throw new Error(`${label} exceeds the supported range`);
  }
  return Number(value);
}

function readUInt64LE(buffer: Buffer, offset: number, label: string): number {
  if (offset < 0 || offset + 8 > buffer.length) {
    throw new Error(`Truncated ${label}`);
  }
  return bigintToSafeNumber(buffer.readBigUInt64LE(offset), label);
}

async function fetchRange(
  url: string,
  start: number,
  end: number,
): Promise<{ data: Buffer; size: number | null }> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw new Error('Invalid remote IPA byte range');
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept-Encoding': 'identity',
      Range: `bytes=${start}-${end}`,
    },
    redirect: 'follow',
  });

  if (response.status !== 206) {
    throw new Error(`Expected partial content, got HTTP ${response.status}`);
  }

  const contentRange = response.headers.get('content-range') ?? '';
  const sizeMatch = contentRange.match(/\/(\d+)\s*$/);
  const size = sizeMatch
    ? bigintToSafeNumber(BigInt(sizeMatch[1]), 'Remote IPA size')
    : null;
  return {
    data: Buffer.from(await response.arrayBuffer()),
    size,
  };
}

async function readRemoteSize(url: string): Promise<number> {
  const { size } = await fetchRange(url, 0, 0);
  if (!size || size <= 0) {
    throw new Error('Missing remote IPA size');
  }
  return size;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let offset = buffer.length - 22; offset >= 0; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('Could not find ZIP end of central directory');
}

async function readCentralDirectoryLocation(
  url: string,
  size: number,
  tailStart: number,
  tail: Buffer,
  eocdOffset: number,
): Promise<CentralDirectoryLocation> {
  if (eocdOffset + 22 > tail.length) {
    throw new Error('Truncated ZIP end of central directory');
  }

  const classicSize = tail.readUInt32LE(eocdOffset + 12);
  const classicOffset = tail.readUInt32LE(eocdOffset + 16);
  if (classicSize !== UINT32_MAX && classicOffset !== UINT32_MAX) {
    return { offset: classicOffset, size: classicSize };
  }

  const locatorOffset = eocdOffset - ZIP64_EOCD_LOCATOR_SIZE;
  if (
    locatorOffset < 0 ||
    tail.readUInt32LE(locatorOffset) !== ZIP64_EOCD_LOCATOR_SIGNATURE
  ) {
    throw new Error('Missing ZIP64 end of central directory locator');
  }

  const zip64EocdOffset = readUInt64LE(
    tail,
    locatorOffset + 8,
    'ZIP64 end of central directory offset',
  );
  if (zip64EocdOffset >= size) {
    throw new Error('Invalid ZIP64 end of central directory offset');
  }

  const relativeOffset = zip64EocdOffset - tailStart;
  const zip64Header =
    relativeOffset >= 0 && relativeOffset + ZIP64_EOCD_MIN_SIZE <= tail.length
      ? tail.subarray(relativeOffset, relativeOffset + ZIP64_EOCD_MIN_SIZE)
      : (
          await fetchRange(
            url,
            zip64EocdOffset,
            zip64EocdOffset + ZIP64_EOCD_MIN_SIZE - 1,
          )
        ).data;

  if (
    zip64Header.length < ZIP64_EOCD_MIN_SIZE ||
    zip64Header.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE
  ) {
    throw new Error('Invalid ZIP64 end of central directory');
  }
  if (readUInt64LE(zip64Header, 4, 'ZIP64 EOCD record size') < 44) {
    throw new Error('Invalid ZIP64 end of central directory record size');
  }

  return {
    size: readUInt64LE(zip64Header, 40, 'ZIP64 central directory size'),
    offset: readUInt64LE(zip64Header, 48, 'ZIP64 central directory offset'),
  };
}

function parseDosDateTime(dateValue: number, timeValue: number): Date | null {
  if (!dateValue) return null;
  const year = 1980 + ((dateValue >> 9) & 0x7f);
  const month = (dateValue >> 5) & 0x0f;
  const day = dateValue & 0x1f;
  const hour = (timeValue >> 11) & 0x1f;
  const minute = (timeValue >> 5) & 0x3f;
  const second = (timeValue & 0x1f) * 2;
  if (!month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function findExtraField(
  buffer: Buffer,
  start: number,
  end: number,
  fieldId: number,
): Buffer | null {
  let offset = start;
  while (offset + 4 <= end) {
    const id = buffer.readUInt16LE(offset);
    const length = buffer.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + length;
    if (dataEnd > end) throw new Error('Truncated ZIP extra field');
    if (id === fieldId) return buffer.subarray(dataStart, dataEnd);
    offset = dataEnd;
  }
  if (offset !== end) throw new Error('Truncated ZIP extra field header');
  return null;
}

function resolveZip64EntryValues(
  extra: Buffer,
  legacyUncompressedSize: number,
  legacyCompressedSize: number,
  legacyLocalHeaderOffset: number,
  legacyDiskStart: number,
): { compressedSize: number; localHeaderOffset: number } {
  let offset = 0;
  const readNext = (label: string) => {
    const value = readUInt64LE(extra, offset, label);
    offset += 8;
    return value;
  };

  if (legacyUncompressedSize === UINT32_MAX) {
    readNext('ZIP64 uncompressed size');
  }
  const compressedSize =
    legacyCompressedSize === UINT32_MAX
      ? readNext('ZIP64 compressed size')
      : legacyCompressedSize;
  const localHeaderOffset =
    legacyLocalHeaderOffset === UINT32_MAX
      ? readNext('ZIP64 local header offset')
      : legacyLocalHeaderOffset;

  if (legacyDiskStart === UINT16_MAX) {
    if (offset + 4 > extra.length) throw new Error('Truncated ZIP64 disk start');
    if (extra.readUInt32LE(offset) !== 0) {
      throw new Error('Multi-disk ZIP archives are not supported');
    }
  } else if (legacyDiskStart !== 0) {
    throw new Error('Multi-disk ZIP archives are not supported');
  }

  return { compressedSize, localHeaderOffset };
}

function findInfoPlistEntry(directory: Buffer): ZipEntry {
  let offset = 0;
  while (offset + 46 <= directory.length) {
    if (directory.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('Invalid ZIP central directory');
    }

    const compressionMethod = directory.readUInt16LE(offset + 10);
    const modifiedTime = directory.readUInt16LE(offset + 12);
    const modifiedDate = directory.readUInt16LE(offset + 14);
    const legacyCompressedSize = directory.readUInt32LE(offset + 20);
    const legacyUncompressedSize = directory.readUInt32LE(offset + 24);
    const filenameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const legacyDiskStart = directory.readUInt16LE(offset + 34);
    const legacyLocalHeaderOffset = directory.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + filenameLength;
    const extraEnd = nameEnd + extraLength;
    const entryEnd = extraEnd + commentLength;
    if (entryEnd > directory.length) {
      throw new Error('Truncated ZIP central directory entry');
    }

    const filename = directory.subarray(nameStart, nameEnd).toString('utf-8');
    if (/^Payload\/[^/]+\.app\/Info\.plist$/.test(filename)) {
      let compressedSize = legacyCompressedSize;
      let localHeaderOffset = legacyLocalHeaderOffset;
      const needsZip64 =
        legacyUncompressedSize === UINT32_MAX ||
        legacyCompressedSize === UINT32_MAX ||
        legacyLocalHeaderOffset === UINT32_MAX ||
        legacyDiskStart === UINT16_MAX;

      if (needsZip64) {
        const zip64Extra = findExtraField(
          directory,
          nameEnd,
          extraEnd,
          ZIP64_EXTRA_FIELD_ID,
        );
        if (!zip64Extra) {
          throw new Error('Missing ZIP64 extended information for Info.plist');
        }
        ({ compressedSize, localHeaderOffset } = resolveZip64EntryValues(
          zip64Extra,
          legacyUncompressedSize,
          legacyCompressedSize,
          legacyLocalHeaderOffset,
          legacyDiskStart,
        ));
      }

      return {
        compressionMethod,
        compressedSize,
        localHeaderOffset,
        modifiedAt: parseDosDateTime(modifiedDate, modifiedTime),
      };
    }

    offset = entryEnd;
  }

  throw new Error('Could not find main app Info.plist');
}

async function readEntryData(url: string, entry: ZipEntry): Promise<Buffer> {
  const header = (
    await fetchRange(url, entry.localHeaderOffset, entry.localHeaderOffset + 29)
  ).data;
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) {
    throw new Error('Invalid ZIP local file header');
  }

  const filenameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + filenameLength + extraLength;
  if (!Number.isSafeInteger(dataStart)) {
    throw new Error('ZIP entry data offset exceeds the supported range');
  }
  if (entry.compressedSize === 0) return Buffer.alloc(0);
  const compressed = (
    await fetchRange(url, dataStart, dataStart + entry.compressedSize - 1)
  ).data;

  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod}`);
}

function parsePlistBuffer(data: Buffer): Record<string, unknown> {
  try {
    const parsed = bplistParser.parseBuffer(data);
    if (parsed.length > 0 && parsed[0] && typeof parsed[0] === 'object') {
      return parsed[0] as Record<string, unknown>;
    }
  } catch {
    // Continue with XML parsing.
  }

  try {
    const parsed = plist.parse(data.toString('utf-8'));
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Report a single stable parsing error below.
  }

  throw new Error('Could not parse IPA Info.plist');
}

function readDisplayVersion(metadata: Record<string, unknown>): string {
  for (const key of ['CFBundleShortVersionString', 'bundleShortVersionString']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  throw new Error('Info.plist does not contain a display version');
}

function parseReleaseDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string' || !value.trim()) return null;

  const trimmed = value.trim();
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const longDate = trimmed.match(
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/,
  );
  if (!longDate) return null;
  const fallback = new Date(`${longDate[2]} ${longDate[3]}, ${longDate[4]} UTC`);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function readReleaseDate(
  metadata: Record<string, unknown>,
  modifiedAt: Date | null,
): Date {
  for (const key of ['releaseDate', 'ReleaseDate']) {
    if (!(key in metadata)) continue;
    const parsed = parseReleaseDate(metadata[key]);
    if (!parsed) throw new Error(`Invalid ${key} in Info.plist`);
    return parsed;
  }
  if (modifiedAt) return modifiedAt;
  throw new Error('Info.plist does not contain a release date');
}

export async function readRemoteIpaVersionMetadata(
  url: string,
): Promise<RemoteIpaVersionMetadata> {
  const size = await readRemoteSize(url);
  const tailStart = Math.max(0, size - MAX_EOCD_SIZE);
  const tail = (await fetchRange(url, tailStart, size - 1)).data;
  const eocdOffset = findEndOfCentralDirectory(tail);
  const directory = await readCentralDirectoryLocation(
    url,
    size,
    tailStart,
    tail,
    eocdOffset,
  );
  const directoryEnd = directory.offset + directory.size;
  if (
    directory.size <= 0 ||
    !Number.isSafeInteger(directoryEnd) ||
    directory.offset < 0 ||
    directoryEnd > size
  ) {
    throw new Error('Invalid ZIP central directory bounds');
  }

  const directoryData = (
    await fetchRange(url, directory.offset, directoryEnd - 1)
  ).data;
  const entry = findInfoPlistEntry(directoryData);
  const metadata = parsePlistBuffer(await readEntryData(url, entry));

  return {
    displayVersion: readDisplayVersion(metadata),
    releaseDate: readReleaseDate(metadata, entry.modifiedAt).toISOString(),
  };
}
