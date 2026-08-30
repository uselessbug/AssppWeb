const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_X86_64 = 0x01000007;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x02;
const MACH_HEADER_64_SIZE = 32;
const NLIST_64_SIZE = 16;

interface SegmentSummary {
  name: string;
  address: number;
  size: number;
}

export interface MachOExportInspection {
  name: string;
  byteLength: number;
  baseAddress: number;
  segments: number;
  exports: number;
  symbol(name: string, loadBase: number): number;
}

export function inspectMachOExports(
  name: string,
  input: Uint8Array,
): MachOExportInspection {
  const data = selectX8664Slice(input);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < MACH_HEADER_64_SIZE || view.getUint32(0, true) !== MH_MAGIC_64) {
    throw new Error(`${name} is not a little-endian 64-bit Mach-O`);
  }
  if (view.getInt32(4, true) !== CPU_TYPE_X86_64) {
    throw new Error(`${name} Mach-O is not x86_64`);
  }

  const commandCount = view.getUint32(16, true);
  const commandBytes = view.getUint32(20, true);
  if (MACH_HEADER_64_SIZE + commandBytes > data.length) {
    throw new Error(`${name} Mach-O load commands exceed the image`);
  }

  const segments: SegmentSummary[] = [];
  let symbolOffset = 0;
  let symbolCount = 0;
  let stringOffset = 0;
  let stringSize = 0;
  let cursor = MACH_HEADER_64_SIZE;

  for (let index = 0; index < commandCount; index++) {
    const command = view.getUint32(cursor, true);
    const commandSize = view.getUint32(cursor + 4, true);
    if (commandSize < 8 || cursor + commandSize > data.length) {
      throw new Error(`${name} has an invalid Mach-O load command size`);
    }

    if (command === LC_SEGMENT_64) {
      const address = readSafeUint64(view, cursor + 24, `${name} segment address`);
      const size = readSafeUint64(view, cursor + 32, `${name} segment size`);
      segments.push({
        name: readFixedCString(data, cursor + 8, 16),
        address,
        size,
      });
    } else if (command === LC_SYMTAB) {
      symbolOffset = view.getUint32(cursor + 8, true);
      symbolCount = view.getUint32(cursor + 12, true);
      stringOffset = view.getUint32(cursor + 16, true);
      stringSize = view.getUint32(cursor + 20, true);
    }

    cursor += commandSize;
  }

  const loadable = segments.filter(
    (segment) => segment.name !== "__PAGEZERO" && segment.size !== 0,
  );
  if (loadable.length === 0) throw new Error(`${name} has no loadable segments`);
  const baseAddress = Math.min(...loadable.map((segment) => segment.address));

  const symbols = new Map<string, number>();
  const symbolBytes = symbolCount * NLIST_64_SIZE;
  if (
    symbolOffset + symbolBytes > data.length ||
    stringOffset + stringSize > data.length
  ) {
    throw new Error(`${name} has a symbol table outside the image`);
  }

  for (let index = 0; index < symbolCount; index++) {
    const offset = symbolOffset + index * NLIST_64_SIZE;
    const stringIndex = view.getUint32(offset, true);
    const type = data[offset + 4];
    if ((type & 0xe0) !== 0 || stringIndex === 0 || stringIndex >= stringSize) continue;
    const symbolName = readCString(data, stringOffset + stringIndex, stringOffset + stringSize);
    if (!symbolName) continue;
    const value = readSafeUint64(view, offset + 8, `${name} symbol value`);
    if (value !== 0) symbols.set(symbolName, value);
  }

  return {
    name,
    byteLength: data.length,
    baseAddress,
    segments: segments.length,
    exports: symbols.size,
    symbol(symbolName: string, loadBase: number) {
      const address = symbols.get(symbolName);
      if (address === undefined) {
        throw new Error(`symbol ${symbolName} was not found in ${name}`);
      }
      const result = loadBase + address - baseAddress;
      if (!Number.isSafeInteger(result) || result < 0) {
        throw new Error(`symbol ${symbolName} address overflows in ${name}`);
      }
      return result;
    },
  };
}

function selectX8664Slice(input: Uint8Array): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return input.slice();

  const count = view.getUint32(4, false);
  const archSize = magic === FAT_MAGIC_64 ? 32 : 20;
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * archSize;
    if (view.getInt32(offset, false) !== CPU_TYPE_X86_64) continue;
    const sliceOffset =
      magic === FAT_MAGIC_64
        ? readSafeUint64(view, offset + 8, "Mach-O slice offset", false)
        : view.getUint32(offset + 8, false);
    const sliceSize =
      magic === FAT_MAGIC_64
        ? readSafeUint64(view, offset + 16, "Mach-O slice size", false)
        : view.getUint32(offset + 12, false);
    if (sliceOffset + sliceSize > input.length) {
      throw new Error("x86_64 Mach-O slice exceeds input size");
    }
    return input.slice(sliceOffset, sliceOffset + sliceSize);
  }

  throw new Error("universal Mach-O has no x86_64 slice");
}

function readSafeUint64(
  view: DataView,
  offset: number,
  label: string,
  littleEndian = true,
): number {
  const lowOffset = littleEndian ? offset : offset + 4;
  const highOffset = littleEndian ? offset + 4 : offset;
  const low = BigInt(view.getUint32(lowOffset, littleEndian));
  const high = BigInt(view.getUint32(highOffset, littleEndian));
  const value = (high << 32n) | low;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

function readFixedCString(input: Uint8Array, start: number, size: number): string {
  let end = start;
  const limit = Math.min(input.length, start + size);
  while (end < limit && input[end] !== 0) end++;
  return new TextDecoder().decode(input.subarray(start, end));
}

function readCString(input: Uint8Array, start: number, limit: number): string {
  let end = start;
  while (end < limit && input[end] !== 0) end++;
  return new TextDecoder().decode(input.subarray(start, end));
}
