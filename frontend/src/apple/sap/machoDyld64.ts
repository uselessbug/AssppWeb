import { BrowserUnicornEngine, SAP_PAGE_SIZE } from "./unicornEngine";

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_X86_64 = 0x01000007;
const LC_SEGMENT_64 = 0x19;
const LC_DYLD_INFO = 0x22;
const LC_DYLD_INFO_ONLY = 0x80000022;
const MACH_HEADER_64_SIZE = 32;
const SEGMENT_COMMAND_64_SIZE = 72;
const MAX_LOAD_COMMANDS = 4096;
const MAX_IMAGE_SPAN = 1 << 30;
const MAX_FIXUPS = 10_000_000;
const POINTER_SIZE = 8;
const UINT64_MASK = (1n << 64n) - 1n;

const REBASE_TYPE_POINTER = 1;
const REBASE_OPCODE_MASK = 0xf0;
const REBASE_IMMEDIATE_MASK = 0x0f;
const REBASE_OPCODE_DONE = 0x00;
const REBASE_OPCODE_SET_TYPE_IMM = 0x10;
const REBASE_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB = 0x20;
const REBASE_OPCODE_ADD_ADDR_ULEB = 0x30;
const REBASE_OPCODE_ADD_ADDR_IMM_SCALED = 0x40;
const REBASE_OPCODE_DO_REBASE_IMM_TIMES = 0x50;
const REBASE_OPCODE_DO_REBASE_ULEB_TIMES = 0x60;
const REBASE_OPCODE_DO_REBASE_ADD_ADDR_ULEB = 0x70;
const REBASE_OPCODE_DO_REBASE_ULEB_TIMES_SKIPPING_ULEB = 0x80;

const BIND_TYPE_POINTER = 1;
const BIND_OPCODE_MASK = 0xf0;
const BIND_IMMEDIATE_MASK = 0x0f;
const BIND_OPCODE_DONE = 0x00;
const BIND_OPCODE_SET_DYLIB_ORDINAL_IMM = 0x10;
const BIND_OPCODE_SET_DYLIB_ORDINAL_ULEB = 0x20;
const BIND_OPCODE_SET_DYLIB_SPECIAL_IMM = 0x30;
const BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM = 0x40;
const BIND_OPCODE_SET_TYPE_IMM = 0x50;
const BIND_OPCODE_SET_ADDEND_SLEB = 0x60;
const BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB = 0x70;
const BIND_OPCODE_ADD_ADDR_ULEB = 0x80;
const BIND_OPCODE_DO_BIND = 0x90;
const BIND_OPCODE_DO_BIND_ADD_ADDR_ULEB = 0xa0;
const BIND_OPCODE_DO_BIND_ADD_ADDR_IMM_SCALED = 0xb0;
const BIND_OPCODE_DO_BIND_ULEB_TIMES_SKIPPING_ULEB = 0xc0;
const BIND_OPCODE_THREADED = 0xd0;

interface MachSegment {
  name: string;
  address: number;
  size: number;
  fileOffset: number;
  fileSize: number;
}

interface MachDyldInfo {
  rebaseOffset: number;
  rebaseSize: number;
  bindOffset: number;
  bindSize: number;
  weakBindOffset: number;
  weakBindSize: number;
  lazyBindOffset: number;
  lazyBindSize: number;
}

export interface MachODyldRelocationSummary {
  name: string;
  segments: number;
  rebases: number;
  binds: number;
}

export type MachODyldSymbolResolver = (name: string) => number;

export function addUint64(left: bigint, right: bigint): bigint {
  return (left + right) & UINT64_MASK;
}

export class BrowserMachODyldImage {
  private relocated = false;
  private loadedBase = 0;
  private rebaseCount = 0;
  private bindCount = 0;

  private constructor(
    readonly name: string,
    private readonly data: Uint8Array,
    private readonly segments: MachSegment[],
    private readonly baseAddress: number,
    private readonly dyldInfo: MachDyldInfo | undefined,
  ) {}

  static open(name: string, input: Uint8Array): BrowserMachODyldImage {
    const data = selectX8664Slice(input);
    if (data.length < MACH_HEADER_64_SIZE) {
      throw new Error(`${name} Mach-O is shorter than its 64-bit header`);
    }

    const view = dataView(data);
    if (view.getUint32(0, true) !== MH_MAGIC_64) {
      throw new Error(`${name} is not a little-endian 64-bit Mach-O`);
    }
    if (view.getInt32(4, true) !== CPU_TYPE_X86_64) {
      throw new Error(`${name} Mach-O is not x86_64`);
    }

    const commandCount = view.getUint32(16, true);
    const commandBytes = view.getUint32(20, true);
    if (commandCount > MAX_LOAD_COMMANDS) {
      throw new Error(`${name} has too many Mach-O load commands: ${commandCount}`);
    }
    if (MACH_HEADER_64_SIZE + commandBytes > data.length) {
      throw new Error(`${name} Mach-O load commands exceed the image`);
    }

    const segments: MachSegment[] = [];
    let dyldInfo: MachDyldInfo | undefined;
    let cursor = MACH_HEADER_64_SIZE;

    for (let index = 0; index < commandCount; index++) {
      if (cursor + 8 > data.length) {
        throw new Error(`${name} Mach-O load command header exceeds the image`);
      }
      const command = view.getUint32(cursor, true);
      const commandSize = view.getUint32(cursor + 4, true);
      if (commandSize < 8 || cursor + commandSize > data.length) {
        throw new Error(`${name} has an invalid Mach-O load command size`);
      }

      if (command === LC_SEGMENT_64) {
        if (commandSize < SEGMENT_COMMAND_64_SIZE) {
          throw new Error(`${name} has a truncated LC_SEGMENT_64 command`);
        }
        const segment: MachSegment = {
          name: readFixedCString(data, cursor + 8, 16),
          address: readSafeUint64(view, cursor + 24, `${name} segment address`),
          size: readSafeUint64(view, cursor + 32, `${name} segment size`),
          fileOffset: readSafeUint64(view, cursor + 40, `${name} segment file offset`),
          fileSize: readSafeUint64(view, cursor + 48, `${name} segment file size`),
        };
        validateSegment(name, data.length, segment);
        segments.push(segment);
      } else if (command === LC_DYLD_INFO || command === LC_DYLD_INFO_ONLY) {
        if (commandSize < 48) {
          throw new Error(`${name} has a truncated LC_DYLD_INFO command`);
        }
        dyldInfo = {
          rebaseOffset: view.getUint32(cursor + 8, true),
          rebaseSize: view.getUint32(cursor + 12, true),
          bindOffset: view.getUint32(cursor + 16, true),
          bindSize: view.getUint32(cursor + 20, true),
          weakBindOffset: view.getUint32(cursor + 24, true),
          weakBindSize: view.getUint32(cursor + 28, true),
          lazyBindOffset: view.getUint32(cursor + 32, true),
          lazyBindSize: view.getUint32(cursor + 36, true),
        };
      }

      cursor += commandSize;
    }

    const loadable = segments.filter(
      (segment) => segment.name !== "__PAGEZERO" && segment.size !== 0,
    );
    if (loadable.length === 0) {
      throw new Error(`${name} has no loadable Mach-O segments`);
    }
    const baseAddress = Math.min(...loadable.map((segment) => segment.address));

    return new BrowserMachODyldImage(
      name,
      data.slice(),
      segments,
      baseAddress,
      dyldInfo,
    );
  }

  relocate(loadBase: number, resolve: MachODyldSymbolResolver) {
    if (this.relocated) throw new Error(`${this.name} is already relocated`);
    assertSafeAddress(loadBase, `${this.name} load base`);

    try {
      this.rebaseCount = this.applyRebases(loadBase);
      this.bindCount = this.applyAllBinds(resolve);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.name} dyld relocation failed: ${message}`);
    }

    this.loadedBase = loadBase;
    this.relocated = true;
  }

  load(engine: BrowserUnicornEngine) {
    if (!this.relocated) {
      throw new Error(`${this.name} must be relocated before loading`);
    }

    let span = 0;
    for (const segment of this.segments) {
      if (segment.name === "__PAGEZERO" || segment.size === 0) continue;
      if (segment.address < this.baseAddress) {
        throw new Error(`segment ${segment.name} in ${this.name} precedes image base`);
      }
      const end = checkedAdd(
        segment.address - this.baseAddress,
        segment.size,
        `${this.name} segment span`,
      );
      if (end > MAX_IMAGE_SPAN) {
        throw new Error(`segment ${segment.name} makes ${this.name} too large`);
      }
      span = Math.max(span, end);
    }

    span = align(span, SAP_PAGE_SIZE);
    if (span === 0) throw new Error(`${this.name} has no loadable segments`);
    engine.memMap(this.loadedBase, span);

    for (const segment of this.segments) {
      if (segment.name === "__PAGEZERO" || segment.fileSize === 0) continue;
      const address = checkedAdd(
        this.loadedBase,
        segment.address - this.baseAddress,
        `${this.name} segment load address`,
      );
      engine.memWrite(
        address,
        this.data.subarray(segment.fileOffset, segment.fileOffset + segment.fileSize),
      );
    }
  }

  summary(): MachODyldRelocationSummary {
    return {
      name: this.name,
      segments: this.segments.length,
      rebases: this.rebaseCount,
      binds: this.bindCount,
    };
  }

  private applyRebases(loadBase: number): number {
    if (!this.dyldInfo || this.dyldInfo.rebaseSize === 0) return 0;
    const stream = sliceRange(
      this.data,
      this.dyldInfo.rebaseOffset,
      this.dyldInfo.rebaseSize,
      `${this.name} rebase`,
    );
    let cursor = 0;
    let type = 0;
    let segmentIndex = -1;
    let segmentOffset = 0n;
    let count = 0;

    const emit = () => {
      if (type !== REBASE_TYPE_POINTER) {
        throw new Error(`unsupported rebase type ${type}`);
      }
      const numericOffset = this.segmentFileOffset(
        segmentIndex,
        segmentOffset,
        POINTER_SIZE,
      );
      const current = readUint64Big(this.data, numericOffset);
      const base = BigInt(this.baseAddress);
      if (current < base) {
        throw new Error(
          `rebase at ${hexBig(segmentOffset)} contains pointer 0x${current.toString(16)} below image base`,
        );
      }
      const relocated = BigInt(loadBase) + current - base;
      writeUint64Big(this.data, numericOffset, relocated, `${this.name} rebase pointer`);
      count++;
      if (count > MAX_FIXUPS) throw new Error("rebase count exceeds safety limit");
    };

    while (cursor < stream.length) {
      const opcodeOffset = cursor;
      const byte = stream[cursor++];
      const opcode = byte & REBASE_OPCODE_MASK;
      const immediate = byte & REBASE_IMMEDIATE_MASK;

      try {
        switch (opcode) {
          case REBASE_OPCODE_DONE:
            return count;
          case REBASE_OPCODE_SET_TYPE_IMM:
            type = immediate;
            break;
          case REBASE_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB: {
            segmentIndex = immediate;
            const value = readUlebBig(stream, cursor, "rebase segment offset");
            cursor = value.next;
            segmentOffset = value.value;
            break;
          }
          case REBASE_OPCODE_ADD_ADDR_ULEB: {
            const value = readUlebBig(stream, cursor, "rebase address delta");
            cursor = value.next;
            segmentOffset = addUint64(segmentOffset, value.value);
            break;
          }
          case REBASE_OPCODE_ADD_ADDR_IMM_SCALED:
            segmentOffset = addUint64(
              segmentOffset,
              BigInt(immediate * POINTER_SIZE),
            );
            break;
          case REBASE_OPCODE_DO_REBASE_IMM_TIMES:
            for (let index = 0; index < immediate; index++) {
              emit();
              segmentOffset = addUint64(segmentOffset, BigInt(POINTER_SIZE));
            }
            break;
          case REBASE_OPCODE_DO_REBASE_ULEB_TIMES: {
            const iterations = readUlebCount(stream, cursor, "rebase count");
            cursor = iterations.next;
            for (let index = 0; index < iterations.value; index++) {
              emit();
              segmentOffset = addUint64(segmentOffset, BigInt(POINTER_SIZE));
            }
            break;
          }
          case REBASE_OPCODE_DO_REBASE_ADD_ADDR_ULEB: {
            emit();
            const skip = readUlebBig(stream, cursor, "rebase skip");
            cursor = skip.next;
            segmentOffset = addUint64(
              segmentOffset,
              BigInt(POINTER_SIZE) + skip.value,
            );
            break;
          }
          case REBASE_OPCODE_DO_REBASE_ULEB_TIMES_SKIPPING_ULEB: {
            const iterations = readUlebCount(stream, cursor, "rebase count");
            cursor = iterations.next;
            const skip = readUlebBig(stream, cursor, "rebase skip");
            cursor = skip.next;
            for (let index = 0; index < iterations.value; index++) {
              emit();
              segmentOffset = addUint64(
                segmentOffset,
                BigInt(POINTER_SIZE) + skip.value,
              );
            }
            break;
          }
          default:
            throw new Error(`unsupported rebase opcode ${hex(opcode)}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`rebase opcode at +${hex(opcodeOffset)}: ${message}`);
      }
    }

    return count;
  }

  private applyAllBinds(resolve: MachODyldSymbolResolver): number {
    if (!this.dyldInfo) return 0;
    return (
      this.applyBindStream(
        this.dyldInfo.bindOffset,
        this.dyldInfo.bindSize,
        false,
        "bind",
        resolve,
      ) +
      this.applyBindStream(
        this.dyldInfo.weakBindOffset,
        this.dyldInfo.weakBindSize,
        false,
        "weak bind",
        resolve,
      ) +
      this.applyBindStream(
        this.dyldInfo.lazyBindOffset,
        this.dyldInfo.lazyBindSize,
        true,
        "lazy bind",
        resolve,
      )
    );
  }

  private applyBindStream(
    offset: number,
    size: number,
    lazy: boolean,
    label: string,
    resolve: MachODyldSymbolResolver,
  ): number {
    if (size === 0) return 0;
    const stream = sliceRange(this.data, offset, size, `${this.name} ${label}`);
    let cursor = 0;
    let type = 0;
    let segmentIndex = -1;
    let segmentOffset = 0n;
    let symbol = "";
    let addend = 0n;
    let count = 0;

    const resetLazyBinding = () => {
      type = 0;
      segmentIndex = -1;
      symbol = "";
      addend = 0n;
      // go-macho keeps segOffset outside the lazy-bind record state.
    };

    const emit = () => {
      if (!symbol) throw new Error(`${label} operation is missing a symbol`);
      if (type !== 0 && type !== BIND_TYPE_POINTER) {
        throw new Error(`unsupported bind type ${type} for ${symbol}`);
      }
      const fileOffset = this.segmentFileOffset(
        segmentIndex,
        segmentOffset,
        POINTER_SIZE,
      );
      const resolved = resolve(symbol);
      assertSafeAddress(resolved, `resolved symbol ${symbol}`);
      const address = BigInt(resolved) + addend;
      writeUint64Big(this.data, fileOffset, address, `${this.name} bind ${symbol}`);
      count++;
      if (count > MAX_FIXUPS) throw new Error(`${label} count exceeds safety limit`);
    };

    while (cursor < stream.length) {
      const opcodeOffset = cursor;
      const byte = stream[cursor++];
      const opcode = byte & BIND_OPCODE_MASK;
      const immediate = byte & BIND_IMMEDIATE_MASK;

      try {
        switch (opcode) {
          case BIND_OPCODE_DONE:
            if (!lazy) return count;
            resetLazyBinding();
            break;
          case BIND_OPCODE_SET_DYLIB_ORDINAL_IMM:
          case BIND_OPCODE_SET_DYLIB_SPECIAL_IMM:
            break;
          case BIND_OPCODE_SET_DYLIB_ORDINAL_ULEB:
            cursor = readUlebBig(stream, cursor, "dylib ordinal").next;
            break;
          case BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM: {
            const value = readCStringWithNext(stream, cursor);
            symbol = value.value;
            cursor = value.next;
            break;
          }
          case BIND_OPCODE_SET_TYPE_IMM:
            type = immediate;
            break;
          case BIND_OPCODE_SET_ADDEND_SLEB: {
            const value = readSlebBig(stream, cursor, "bind addend");
            addend = value.value;
            cursor = value.next;
            break;
          }
          case BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB: {
            segmentIndex = immediate;
            const value = readUlebBig(stream, cursor, "bind segment offset");
            cursor = value.next;
            segmentOffset = value.value;
            break;
          }
          case BIND_OPCODE_ADD_ADDR_ULEB: {
            const value = readUlebBig(stream, cursor, "bind address delta");
            cursor = value.next;
            segmentOffset = addUint64(segmentOffset, value.value);
            break;
          }
          case BIND_OPCODE_DO_BIND:
            emit();
            segmentOffset = addUint64(segmentOffset, BigInt(POINTER_SIZE));
            break;
          case BIND_OPCODE_DO_BIND_ADD_ADDR_ULEB: {
            emit();
            const skip = readUlebBig(stream, cursor, "bind skip");
            cursor = skip.next;
            segmentOffset = addUint64(
              segmentOffset,
              BigInt(POINTER_SIZE) + skip.value,
            );
            break;
          }
          case BIND_OPCODE_DO_BIND_ADD_ADDR_IMM_SCALED:
            emit();
            segmentOffset = addUint64(
              segmentOffset,
              BigInt(POINTER_SIZE * (immediate + 1)),
            );
            break;
          case BIND_OPCODE_DO_BIND_ULEB_TIMES_SKIPPING_ULEB: {
            const iterations = readUlebCount(stream, cursor, "bind count");
            cursor = iterations.next;
            const skip = readUlebBig(stream, cursor, "bind skip");
            cursor = skip.next;
            for (let index = 0; index < iterations.value; index++) {
              emit();
              segmentOffset = addUint64(
                segmentOffset,
                BigInt(POINTER_SIZE) + skip.value,
              );
            }
            break;
          }
          case BIND_OPCODE_THREADED:
            throw new Error(`threaded ${label} opcodes are not supported by this SAP loader`);
          default:
            throw new Error(`unsupported ${label} opcode ${hex(opcode)}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} opcode at +${hex(opcodeOffset)}: ${message}`);
      }
    }

    return count;
  }

  private segmentFileOffset(
    segmentIndex: number,
    offset: bigint,
    size: number,
  ): number {
    const segment = this.segments[segmentIndex];
    if (!segment) {
      throw new Error(`fixup references unknown segment ${segmentIndex}`);
    }

    const segmentSize = BigInt(segment.size);
    const end = offset + BigInt(size);
    if (offset > segmentSize || end > segmentSize) {
      throw new Error(
        `fixup at ${hexBig(offset)} exceeds segment ${segment.name} (size=${hex(segment.size)})`,
      );
    }
    if (end > BigInt(segment.fileSize)) {
      throw new Error(
        `fixup at ${hexBig(offset)} exceeds file data for segment ${segment.name}`,
      );
    }
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`fixup offset ${hexBig(offset)} exceeds JavaScript safe integer range`);
    }

    const numericOffset = Number(offset);
    const fileOffset = checkedAdd(
      segment.fileOffset,
      numericOffset,
      `${this.name} fixup file offset`,
    );
    if (fileOffset + size > this.data.length) {
      throw new Error(`fixup at ${hex(fileOffset)} exceeds image data`);
    }
    return fileOffset;
  }
}

function selectX8664Slice(input: Uint8Array): Uint8Array {
  if (input.length < 8) throw new Error("Mach-O input is too short");
  const view = dataView(input);
  const magic = view.getUint32(0, false);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return input.slice();

  const count = view.getUint32(4, false);
  if (count > 64) throw new Error(`universal Mach-O has too many slices: ${count}`);
  const archSize = magic === FAT_MAGIC_64 ? 32 : 20;
  if (8 + count * archSize > input.length) {
    throw new Error("universal Mach-O architecture table exceeds input");
  }

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

function validateSegment(name: string, dataLength: number, segment: MachSegment) {
  if (segment.fileSize > segment.size) {
    throw new Error(`segment ${segment.name} file data exceeds its memory size in ${name}`);
  }
  if (segment.fileOffset + segment.fileSize > dataLength) {
    throw new Error(`segment ${segment.name} data exceeds ${name}`);
  }
}

function sliceRange(
  data: Uint8Array,
  offset: number,
  size: number,
  label: string,
): Uint8Array {
  const end = offset + size;
  if (
    !Number.isSafeInteger(end) ||
    offset < 0 ||
    size < 0 ||
    end > data.length
  ) {
    throw new Error(`${label} stream exceeds image`);
  }
  return data.subarray(offset, end);
}

function readUlebCount(
  input: Uint8Array,
  start: number,
  label: string,
): { value: number; next: number } {
  const result = readUlebBig(input, start, label);
  if (result.value > BigInt(MAX_FIXUPS)) {
    throw new Error(`${label} ${result.value.toString()} exceeds safety limit`);
  }
  return { value: Number(result.value), next: result.next };
}

function readUlebBig(
  input: Uint8Array,
  start: number,
  label: string,
): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = start;

  for (let index = 0; index < 10; index++) {
    if (cursor >= input.length) {
      throw new Error(`truncated ${label} ULEB128 at +${hex(start)}`);
    }
    const byte = input[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (index === 9 && byte > 1) {
        throw new Error(`${label} ULEB128 at +${hex(start)} exceeds uint64`);
      }
      return { value, next: cursor };
    }
    shift += 7n;
  }

  throw new Error(`${label} ULEB128 at +${hex(start)} exceeds uint64`);
}

function readSlebBig(
  input: Uint8Array,
  start: number,
  label: string,
): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = start;
  let byte = 0;

  for (let index = 0; index < 10; index++) {
    if (cursor >= input.length) {
      throw new Error(`truncated ${label} SLEB128 at +${hex(start)}`);
    }
    byte = input[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) {
      if ((byte & 0x40) !== 0) value |= (-1n) << shift;
      return { value, next: cursor };
    }
  }

  throw new Error(`${label} SLEB128 at +${hex(start)} exceeds int64`);
}

function readCStringWithNext(
  input: Uint8Array,
  start: number,
): { value: string; next: number } {
  let end = start;
  while (end < input.length && input[end] !== 0) end++;
  if (end >= input.length) {
    throw new Error(`unterminated bind symbol at +${hex(start)}`);
  }
  return {
    value: new TextDecoder().decode(input.subarray(start, end)),
    next: end + 1,
  };
}

function readFixedCString(input: Uint8Array, start: number, size: number): string {
  const limit = Math.min(input.length, start + size);
  let end = start;
  while (end < limit && input[end] !== 0) end++;
  return new TextDecoder().decode(input.subarray(start, end));
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

function readUint64Big(input: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > input.length) {
    throw new Error("64-bit pointer read exceeds Mach-O image");
  }
  const view = dataView(input);
  return (
    BigInt(view.getUint32(offset, true)) |
    (BigInt(view.getUint32(offset + 4, true)) << 32n)
  );
}

function writeUint64Big(
  input: Uint8Array,
  offset: number,
  value: bigint,
  label: string,
) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${label} result 0x${value.toString(16)} exceeds guest safe address range`,
    );
  }
  if (offset < 0 || offset + 8 > input.length) {
    throw new Error(`${label} write exceeds Mach-O image`);
  }
  const view = dataView(input);
  view.setUint32(offset, Number(value & 0xffffffffn), true);
  view.setUint32(offset + 4, Number((value >> 32n) & 0xffffffffn), true);
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }
  return result;
}

function assertSafeAddress(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is outside the guest safe address range`);
  }
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function dataView(input: Uint8Array): DataView {
  return new DataView(input.buffer, input.byteOffset, input.byteLength);
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function hexBig(value: bigint): string {
  return `0x${value.toString(16)}`;
}
