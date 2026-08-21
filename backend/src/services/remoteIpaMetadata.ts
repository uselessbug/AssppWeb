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

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_EOCD_SIZE = 65_557;

async function fetchRange(
  url: string,
  start: number,
  end: number,
): Promise<{ data: Buffer; size: number | null }> {
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
  const size = sizeMatch ? Number(sizeMatch[1]) : null;
  return {
    data: Buffer.from(await response.arrayBuffer()),
    size: Number.isFinite(size) ? size : null,
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

function findInfoPlistEntry(directory: Buffer): ZipEntry {
  let offset = 0;
  while (offset + 46 <= directory.length) {
    if (directory.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('Invalid ZIP central directory');
    }

    const compressionMethod = directory.readUInt16LE(offset + 10);
    const modifiedTime = directory.readUInt16LE(offset + 12);
    const modifiedDate = directory.readUInt16LE(offset + 14);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const filenameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const localHeaderOffset = directory.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + filenameLength;
    if (nameEnd > directory.length) {
      throw new Error('Truncated ZIP central directory entry');
    }

    const filename = directory.subarray(nameStart, nameEnd).toString('utf-8');
    if (/^Payload\/[^/]+\.app\/Info\.plist$/.test(filename)) {
      return {
        compressionMethod,
        compressedSize,
        localHeaderOffset,
        modifiedAt: parseDosDateTime(modifiedDate, modifiedTime),
      };
    }

    offset = nameEnd + extraLength + commentLength;
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
  const directorySize = tail.readUInt32LE(eocdOffset + 12);
  const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
  if (directorySize <= 0 || directoryOffset + directorySize > size) {
    throw new Error('Invalid ZIP central directory bounds');
  }

  const directory = (
    await fetchRange(
      url,
      directoryOffset,
      directoryOffset + directorySize - 1,
    )
  ).data;
  const entry = findInfoPlistEntry(directory);
  const metadata = parsePlistBuffer(await readEntryData(url, entry));

  return {
    displayVersion: readDisplayVersion(metadata),
    releaseDate: readReleaseDate(metadata, entry.modifiedAt).toISOString(),
  };
}
