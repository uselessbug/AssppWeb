import { BrowserUnicornEngine, SAP_PAGE_SIZE } from "./unicornEngine";

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_X86_64 = 0x01000007;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x02;
const LC_DYLD_INFO = 0x22;
const LC_DYLD_INFO_ONLY = 0x80000022;
const MACH_HEADER_64_SIZE = 32;
const SEGMENT_COMMAND_64_SIZE = 72;
const NLIST_64_SIZE = 16;
const MAX_LOAD_COMMANDS = 4096;
const MAX_IMAGE_SPAN = 1 << 30;
const POINTER_SIZE = 8;

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

interface MachSymtab {
  symbolOffset: number;
  symbolCount: number;
  stringOffset: number;
  stringSize: number;
}

interface MachRebase {
  type: number;
  segmentIndex: number;
  segmentOffset: number;
}

interface MachBind {
  type: number;
  segmentIndex: number;
  segmentOffset: number;
  symbol: string;
  addend: number;
}

export interface MachOImageSummary {
  name: string;
  byteLength: number;
  baseAddress: number;
  segments: number;
  exports: number;
  rebases: number;
  binds: number;
}

export type MachSymbolResolver = (name: string) => number;

export class BrowserMachOImage {
  private readonly symbols = new Map<string, number>();
  private readonly rebases: MachRebase[];
  private readonly binds: MachBind[];
  private relocated = false;
  private loadedBase = 0;

  private constructor(
    readonly name: string,
    private readonly data: Uint8Array,
    private readonly segments: MachSegment[],
    private readonly baseAddress: number,
    symtab: MachSymtab | undefined,
    dyldInfo: MachDyldInfo | undefined,
  ) {
    if (symtab) this.parseSymbols(symtab);
    this.rebases = dyldInfo
      ? parseRebaseStream(data, dyldInfo, segments)
      : [];
    this.binds = dyldInfo
      ? parseAllBindStreams(data, dyldInfo, segments)
      : [];
  }

  static open(name: string, input: Uint8Array): BrowserMachOImage {
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
    let symtab: MachSymtab | undefined;
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
      } else if (command === LC_SYMTAB) {
        if (commandSize < 24) {
          throw new Error(`${name} has a truncated LC_SYMTAB command`);
        }
        symtab = {
          symbolOffset: view.getUint32(cursor + 8, true),
          symbolCount: view.getUint32(cursor + 12, true),
          stringOffset: view.getUint32(cursor + 16, true),
          stringSize: view.getUint32(cursor + 20, true),
        };
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

    return new BrowserMachOImage(
      name,
      data.slice(),
      segments,
      baseAddress,
      symtab,
      dyldInfo,
    );
  }

  summary(): MachOImageSummary {
    return {
      name: this.name,
      byteLength: this.data.length,
      baseAddress: this.baseAddress,
      segments: this.segments.length,
      exports: this.symbols.size,
      rebases: this.rebases.length,
      binds: this.binds.length,
    };
  }

  export(name: string, loadBase: number): number {
    const address = this.symbols.get(name);
    if (address === undefined) {
      throw new Error(`symbol ${name} was not found in ${this.name}`);
    }
    if (address < this.baseAddress) {
      throw new Error(`symbol ${name} in ${this.name} precedes image base`);
    }
    return checkedAdd(loadBase, address - this.baseAddress, `${this.name} export`);
  }

  relocate(loadBase: number, resolve: MachSymbolResolver) {
    if (this.relocated) {
      throw new Error(`${this.name} is already relocated`);
    }

    for (const rebase of this.rebases) {
      if (rebase.type !== REBASE_TYPE_POINTER) {
        throw new Error(`${this.name} uses unsupported rebase type ${rebase.type}`);
      }
      const fileOffset = this.segmentFileOffset(
        rebase.segmentIndex,
        rebase.segmentOffset,
        POINTER_SIZE,
      );
      const current = readSafeUint64(
        dataView(this.data),
        fileOffset,
        `${this.name} rebase pointer`,
      );
      if (current < this.baseAddress) {
        throw new Error(`${this.name} contains a rebase below its image base`);
      }
      const relocated = checkedAdd(
        loadBase,
        current - this.baseAddress,
        `${this.name} rebase address`,
      );
      writeUint64(this.data, fileOffset, relocated);
    }

    for (const bind of this.binds) {
      if (bind.type !== 0 && bind.type !== BIND_TYPE_POINTER) {
        throw new Error(
          `${this.name} uses unsupported bind type ${bind.type} for ${bind.symbol}`,
        );
      }
      const fileOffset = this.segmentFileOffset(
        bind.segmentIndex,
        bind.segmentOffset,
        POINTER_SIZE,
      );
      const resolved = resolve(bind.symbol);
      const address = checkedSignedAdd(
        resolved,
        bind.addend,
        `${this.name} bind ${bind.symbol}`,
      );
      writeUint64(this.data, fileOffset, address);
    }

    this.relocated = true;
    this.loadedBase = loadBase;
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
    if (span === 0) {
      throw new Error(`${this.name} has no loadable segments`);
    }
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

  private parseSymbols(symtab: MachSymtab) {
    const symbolBytes = symtab.symbolCount * NLIST_64_SIZE;
    if (
      !Number.isSafeInteger(symbolBytes) ||
      symtab.symbolOffset + symbolBytes > this.data.length ||
      symtab.stringOffset + symtab.stringSize > this.data.length
    ) {
      throw new Error(`${this.name} has a symbol table outside the image`);
    }

    const view = dataView(this.data);
    for (let index = 0; index < symtab.symbolCount; index++) {
      const offset = symtab.symbolOffset + index * NLIST_64_SIZE;
      const stringIndex = view.getUint32(offset, true);
      const type = this.data[offset + 4];
      if ((type & 0xe0) !== 0 || stringIndex === 0 || stringIndex >= symtab.stringSize) {
        continue;
      }
      const name = readCString(
        this.data,
        symtab.stringOffset + stringIndex,
        symtab.stringOffset + symtab.stringSize,
      );
      if (!name) continue;
      const value = readSafeUint64(view, offset + 8, `${this.name} symbol value`);
      if (value !== 0) this.symbols.set(name, value);
    }
  }

  private segmentFileOffset(segmentIndex: number, offset: number, size: number): number {
    const segment = this.segments[segmentIndex];
    if (!segment) {
      throw new Error(`fixup references unknown segment ${segmentIndex} in ${this.name}`);
    }
    const end = checkedAdd(offset, size, `${this.name} fixup range`);
    if (end > segment.size) {
      throw new Error(`fixup at ${hex(offset)} exceeds segment ${segment.name} in ${this.name}`);
    }
    if (end > segment.fileSize) {
      throw new Error(
        `fixup at ${hex(offset)} exceeds file data for segment ${segment.name} in ${this.name}`,
      );
    }
    const result = checkedAdd(segment.fileOffset, offset, `${this.name} fixup offset`);
    if (result + size > this.data.length) {
      throw new Error(`fixup at ${hex(result)} exceeds ${this.name}`);
    }
    return result;
  }
}

function selectX8664Slice(input: Uint8Array): Uint8Array {
  if (input.length < 8) throw new Error("Mach-O input is too short");
  const view = dataView(input);
  const fatMagic = view.getUint32(0, false);
  if (fatMagic !== FAT_MAGIC && fatMagic !== FAT_MAGIC_64) {
    return input.slice();
  }

  const count = view.getUint32(4, false);
  if (count > 64) throw new Error(`universal Mach-O has too many slices: ${count}`);
  const archSize = fatMagic === FAT_MAGIC_64 ? 32 : 20;
  if (8 + count * archSize > input.length) {
    throw new Error("universal Mach-O architecture table exceeds input");
  }

  for (let index = 0; index < count; index++) {
    const offset = 8 + index * archSize;
    if (view.getInt32(offset, false) !== CPU_TYPE_X86_64) continue;
    const sliceOffset =
      fatMagic === FAT_MAGIC_64
        ? readSafeUint64(view, offset + 8, "universal Mach-O slice offset", false)
        : view.getUint32(offset + 8, false);
    const sliceSize =
      fatMagic === FAT_MAGIC_64
        ? readSafeUint64(view, offset + 16, "universal Mach-O slice size", false)
        : view.getUint32(offset + 12, false);
    if (sliceOffset + sliceSize > input.length) {
      throw new Error("x86_64 Mach-O slice exceeds input size");
    }
    return input.slice(sliceOffset, sliceOffset + sliceSize);
  }

  throw new Error("universal Mach-O has no x86_64 slice");
}

function parseRebaseStream(
  data: Uint8Array,
  info: MachDyldInfo,
  segments: MachSegment[],
): MachRebase[] {
  const stream = sliceRange(data, info.rebaseOffset, info.rebaseSize, "rebase");
  const output: MachRebase[] = [];
  let cursor = 0;
  let type = REBASE_TYPE_POINTER;
  let segmentIndex = 0;
  let segmentOffset = 0;

  const emit = () => {
    const segment = segments[segmentIndex];
    if (!segment) throw new Error(`rebase references unknown segment ${segmentIndex}`);
    if (segmentOffset + POINTER_SIZE > segment.size) {
      throw new Error(`rebase exceeds segment ${segment.name}`);
    }
    output.push({ type, segmentIndex, segmentOffset });
  };

  while (cursor < stream.length) {
    const byte = stream[cursor++];
    const opcode = byte & REBASE_OPCODE_MASK;
    const immediate = byte & REBASE_IMMEDIATE_MASK;

    switch (opcode) {
      case REBASE_OPCODE_DONE:
        return output;
      case REBASE_OPCODE_SET_TYPE_IMM:
        type = immediate;
        break;
      case REBASE_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB: {
        segmentIndex = immediate;
        const value = readUleb(stream, cursor);
        cursor = value.next;
        segmentOffset = value.value;
        break;
      }
      case REBASE_OPCODE_ADD_ADDR_ULEB: {
        const value = readUleb(stream, cursor);
        cursor = value.next;
        segmentOffset = checkedAdd(segmentOffset, value.value, "rebase offset");
        break;
      }
      case REBASE_OPCODE_ADD_ADDR_IMM_SCALED:
        segmentOffset = checkedAdd(
          segmentOffset,
          immediate * POINTER_SIZE,
          "rebase scaled offset",
        );
        break;
      case REBASE_OPCODE_DO_REBASE_IMM_TIMES:
        for (let index = 0; index < immediate; index++) {
          emit();
          segmentOffset = checkedAdd(segmentOffset, POINTER_SIZE, "rebase offset");
        }
        break;
      case REBASE_OPCODE_DO_REBASE_ULEB_TIMES: {
        const count = readUleb(stream, cursor);
        cursor = count.next;
        for (let index = 0; index < count.value; index++) {
          emit();
          segmentOffset = checkedAdd(segmentOffset, POINTER_SIZE, "rebase offset");
        }
        break;
      }
      case REBASE_OPCODE_DO_REBASE_ADD_ADDR_ULEB: {
        emit();
        const skip = readUleb(stream, cursor);
        cursor = skip.next;
        segmentOffset = checkedAdd(
          segmentOffset,
          POINTER_SIZE + skip.value,
          "rebase offset",
        );
        break;
      }
      case REBASE_OPCODE_DO_REBASE_ULEB_TIMES_SKIPPING_ULEB: {
        const count = readUleb(stream, cursor);
        cursor = count.next;
        const skip = readUleb(stream, cursor);
        cursor = skip.next;
        for (let index = 0; index < count.value; index++) {
          emit();
          segmentOffset = checkedAdd(
            segmentOffset,
            POINTER_SIZE + skip.value,
            "rebase offset",
          );
        }
        break;
      }
      default:
        throw new Error(`unsupported rebase opcode ${hex(opcode)}`);
    }
  }

  return output;
}

function parseAllBindStreams(
  data: Uint8Array,
  info: MachDyldInfo,
  segments: MachSegment[],
): MachBind[] {
  return [
    ...parseBindStream(data, info.bindOffset, info.bindSize, segments, false, "bind"),
    ...parseBindStream(
      data,
      info.weakBindOffset,
      info.weakBindSize,
      segments,
      false,
      "weak bind",
    ),
    ...parseBindStream(
      data,
      info.lazyBindOffset,
      info.lazyBindSize,
      segments,
      true,
      "lazy bind",
    ),
  ];
}

function parseBindStream(
  data: Uint8Array,
  offset: number,
  size: number,
  segments: MachSegment[],
  multipleSequences: boolean,
  label: string,
): MachBind[] {
  const stream = sliceRange(data, offset, size, label);
  const output: MachBind[] = [];
  let cursor = 0;
  let type = BIND_TYPE_POINTER;
  let segmentIndex = 0;
  let segmentOffset = 0;
  let symbol = "";
  let addend = 0;

  const reset = () => {
    type = BIND_TYPE_POINTER;
    segmentIndex = 0;
    segmentOffset = 0;
    symbol = "";
    addend = 0;
  };
  const emit = () => {
    if (!symbol) throw new Error(`${label} operation is missing a symbol`);
    const segment = segments[segmentIndex];
    if (!segment) throw new Error(`${label} references unknown segment ${segmentIndex}`);
    if (segmentOffset + POINTER_SIZE > segment.size) {
      throw new Error(`${label} for ${symbol} exceeds segment ${segment.name}`);
    }
    output.push({ type, segmentIndex, segmentOffset, symbol, addend });
  };

  while (cursor < stream.length) {
    const byte = stream[cursor++];
    const opcode = byte & BIND_OPCODE_MASK;
    const immediate = byte & BIND_IMMEDIATE_MASK;

    switch (opcode) {
      case BIND_OPCODE_DONE:
        if (!multipleSequences) return output;
        reset();
        break;
      case BIND_OPCODE_SET_DYLIB_ORDINAL_IMM:
      case BIND_OPCODE_SET_DYLIB_SPECIAL_IMM:
        break;
      case BIND_OPCODE_SET_DYLIB_ORDINAL_ULEB: {
        const value = readUleb(stream, cursor);
        cursor = value.next;
        break;
      }
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
        const value = readSleb(stream, cursor);
        addend = value.value;
        cursor = value.next;
        break;
      }
      case BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB: {
        segmentIndex = immediate;
        const value = readUleb(stream, cursor);
        cursor = value.next;
        segmentOffset = value.value;
        break;
      }
      case BIND_OPCODE_ADD_ADDR_ULEB: {
        const value = readUleb(stream, cursor);
        cursor = value.next;
        segmentOffset = checkedAdd(segmentOffset, value.value, `${label} offset`);
        break;
      }
      case BIND_OPCODE_DO_BIND:
        emit();
        segmentOffset = checkedAdd(segmentOffset, POINTER_SIZE, `${label} offset`);
        break;
      case BIND_OPCODE_DO_BIND_ADD_ADDR_ULEB: {
        emit();
        const skip = readUleb(stream, cursor);
        cursor = skip.next;
        segmentOffset = checkedAdd(
          segmentOffset,
          POINTER_SIZE + skip.value,
          `${label} offset`,
        );
        break;
      }
      case BIND_OPCODE_DO_BIND_ADD_ADDR_IMM_SCALED:
        emit();
        segmentOffset = checkedAdd(
          segmentOffset,
          POINTER_SIZE * (immediate + 1),
          `${label} offset`,
        );
        break;
      case BIND_OPCODE_DO_BIND_ULEB_TIMES_SKIPPING_ULEB: {
        const count = readUleb(stream, cursor);
        cursor = count.next;
        const skip = readUleb(stream, cursor);
        cursor = skip.next;
        for (let index = 0; index < count.value; index++) {
          emit();
          segmentOffset = checkedAdd(
            segmentOffset,
            POINTER_SIZE + skip.value,
            `${label} offset`,
          );
        }
        break;
      }
      case BIND_OPCODE_THREADED:
        throw new Error(`${label} uses unsupported threaded bind opcodes`);
      default:
        throw new Error(`unsupported ${label} opcode ${hex(opcode)}`);
    }
  }

  return output;
}

function validateSegment(name: string, dataLength: number, segment: MachSegment) {
  if (segment.fileSize > segment.size) {
    throw new Error(
      `segment ${segment.name} file data exceeds its memory size in ${name}`,
    );
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
  if (size === 0) return new Uint8Array();
  if (offset + size > data.length) {
    throw new Error(`Mach-O ${label} stream exceeds image`);
  }
  return data.subarray(offset, offset + size);
}

function readUleb(input: Uint8Array, start: number): { value: number; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = start;
  while (cursor < input.length) {
    const byte = input[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("ULEB128 value exceeds JavaScript safe integer range");
      }
      return { value: Number(value), next: cursor };
    }
    shift += 7n;
    if (shift > 63n) throw new Error("ULEB128 value is too large");
  }
  throw new Error("truncated ULEB128 value");
}

function readSleb(input: Uint8Array, start: number): { value: number; next: number } {
  let value = 0n;
  let shift = 0n;
  let byte = 0;
  let cursor = start;
  do {
    if (cursor >= input.length) throw new Error("truncated SLEB128 value");
    byte = input[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if (shift > 63n) throw new Error("SLEB128 value is too large");
  } while ((byte & 0x80) !== 0);

  if ((byte & 0x40) !== 0) value |= (-1n) << shift;
  if (
    value < BigInt(Number.MIN_SAFE_INTEGER) ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("SLEB128 value exceeds JavaScript safe integer range");
  }
  return { value: Number(value), next: cursor };
}

function readCStringWithNext(
  input: Uint8Array,
  start: number,
): { value: string; next: number } {
  let end = start;
  while (end < input.length && input[end] !== 0) end++;
  if (end >= input.length) throw new Error("unterminated Mach-O bind symbol");
  return {
    value: new TextDecoder().decode(input.subarray(start, end)),
    next: end + 1,
  };
}

function readFixedCString(input: Uint8Array, start: number, size: number): string {
  const end = Math.min(input.length, start + size);
  let terminator = start;
  while (terminator < end && input[terminator] !== 0) terminator++;
  return new TextDecoder().decode(input.subarray(start, terminator));
}

function readCString(input: Uint8Array, start: number, end: number): string {
  let cursor = start;
  while (cursor < end && input[cursor] !== 0) cursor++;
  return new TextDecoder().decode(input.subarray(start, cursor));
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

function writeUint64(input: Uint8Array, offset: number, value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || offset + 8 > input.length) {
    throw new Error("invalid Mach-O 64-bit pointer write");
  }
  const big = BigInt(value);
  const view = dataView(input);
  view.setUint32(offset, Number(big & 0xffffffffn), true);
  view.setUint32(offset + 4, Number(big >> 32n), true);
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }
  return result;
}

function checkedSignedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} overflows or underflows`);
  }
  return result;
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
