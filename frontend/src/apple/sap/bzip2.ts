const BLOCK_MAGIC = 0x314159265359n;
const FINAL_MAGIC = 0x177245385090n;
const MAX_HUFFMAN_GROUPS = 6;
const MAX_ALPHA_SIZE = 258;
const GROUP_SIZE = 50;
const MAX_CODE_LENGTH = 20;

export class Bzip2NeedMoreData extends Error {
  constructor() {
    super("bzip2 input needs more data");
    this.name = "Bzip2NeedMoreData";
  }
}

export interface Bzip2BlockResult {
  output: Uint8Array;
  nextBit: number;
  endOfStream: boolean;
  storedCrc: number;
}

interface HuffmanTable {
  minLength: number;
  maxLength: number;
  limit: Int32Array;
  base: Int32Array;
  perm: Int32Array;
}

class BitReader {
  position: number;

  constructor(
    private readonly input: Uint8Array,
    position: number,
  ) {
    this.position = position;
  }

  readBit(): number {
    if (this.position >= this.input.length * 8) {
      throw new Bzip2NeedMoreData();
    }

    const byte = this.input[this.position >>> 3];
    const value = (byte >>> (7 - (this.position & 7))) & 1;
    this.position++;
    return value;
  }

  readBits(count: number): number {
    if (count < 0 || count > 32) {
      throw new Error(`invalid bzip2 bit count ${count}`);
    }
    if (this.position + count > this.input.length * 8) {
      throw new Bzip2NeedMoreData();
    }

    let value = 0;
    for (let index = 0; index < count; index++) {
      value = value * 2 + this.readBit();
    }
    return value >>> 0;
  }

  readUint48(): bigint {
    const high = BigInt(this.readBits(24));
    const low = BigInt(this.readBits(24));
    return (high << 24n) | low;
  }
}

export function decodeBzip2Block(
  input: Uint8Array,
  startBit: number,
  blockSize = 900_000,
): Bzip2BlockResult {
  const bits = new BitReader(input, startBit);
  const magic = bits.readUint48();
  if (magic === FINAL_MAGIC) {
    return {
      output: new Uint8Array(),
      nextBit: bits.position,
      endOfStream: true,
      storedCrc: bits.readBits(32),
    };
  }
  if (magic !== BLOCK_MAGIC) {
    throw new Error(`invalid bzip2 block magic 0x${magic.toString(16)}`);
  }

  const storedCrc = bits.readBits(32);
  if (bits.readBit() !== 0) {
    throw new Error("randomized bzip2 blocks are unsupported");
  }
  const origPtr = bits.readBits(24);

  const inUse = new Uint8Array(256);
  const inUse16 = bits.readBits(16);
  for (let group = 0; group < 16; group++) {
    if ((inUse16 & (1 << (15 - group))) === 0) continue;
    const mask = bits.readBits(16);
    for (let index = 0; index < 16; index++) {
      if ((mask & (1 << (15 - index))) !== 0) {
        inUse[group * 16 + index] = 1;
      }
    }
  }

  const symbols: number[] = [];
  for (let value = 0; value < 256; value++) {
    if (inUse[value]) symbols.push(value);
  }
  const alphaSize = symbols.length + 2;
  if (alphaSize < 3 || alphaSize > MAX_ALPHA_SIZE) {
    throw new Error(`invalid bzip2 alphabet size ${alphaSize}`);
  }

  const groupCount = bits.readBits(3);
  if (groupCount < 2 || groupCount > MAX_HUFFMAN_GROUPS) {
    throw new Error(`invalid bzip2 Huffman group count ${groupCount}`);
  }
  const selectorCount = bits.readBits(15);
  if (selectorCount < 1 || selectorCount > 18002) {
    throw new Error(`invalid bzip2 selector count ${selectorCount}`);
  }

  const selectorMtf = new Uint8Array(selectorCount);
  for (let index = 0; index < selectorCount; index++) {
    let value = 0;
    while (bits.readBit() !== 0) {
      value++;
      if (value >= groupCount) {
        throw new Error("invalid bzip2 selector MTF value");
      }
    }
    selectorMtf[index] = value;
  }

  const selectorList = Array.from({ length: groupCount }, (_, index) => index);
  const selectors = new Uint8Array(selectorCount);
  for (let index = 0; index < selectorCount; index++) {
    const mtf = selectorMtf[index];
    const value = selectorList[mtf];
    for (let cursor = mtf; cursor > 0; cursor--) {
      selectorList[cursor] = selectorList[cursor - 1];
    }
    selectorList[0] = value;
    selectors[index] = value;
  }

  const tables: HuffmanTable[] = [];
  for (let group = 0; group < groupCount; group++) {
    const lengths = new Uint8Array(alphaSize);
    let current = bits.readBits(5);
    for (let symbol = 0; symbol < alphaSize; symbol++) {
      while (bits.readBit() !== 0) {
        current += bits.readBit() === 0 ? 1 : -1;
        if (current < 1 || current > MAX_CODE_LENGTH) {
          throw new Error(`invalid bzip2 Huffman code length ${current}`);
        }
      }
      lengths[symbol] = current;
    }
    tables.push(buildHuffmanTable(lengths));
  }

  const mtf = symbols.slice();
  const tt = new Uint32Array(blockSize);
  const counts = new Uint32Array(256);
  let outputLength = 0;
  let selectorIndex = 0;
  let groupRemaining = 0;
  let table: HuffmanTable | undefined;
  const eob = symbols.length + 1;

  const nextSymbol = () => {
    if (groupRemaining === 0) {
      if (selectorIndex >= selectors.length) {
        throw new Error("bzip2 selector list ended before EOB");
      }
      table = tables[selectors[selectorIndex++]];
      groupRemaining = GROUP_SIZE;
    }
    groupRemaining--;
    return decodeHuffman(bits, table!);
  };

  let value = nextSymbol();
  while (value !== eob) {
    if (value === 0 || value === 1) {
      let repeat = 0;
      let power = 1;
      do {
        repeat += power << value;
        if (power > blockSize) {
          throw new Error("bzip2 run length overflows block size");
        }
        power <<= 1;
        value = nextSymbol();
      } while (value === 0 || value === 1);

      if (mtf.length === 0 || outputLength + repeat > blockSize) {
        throw new Error("bzip2 run exceeds block size");
      }
      const byte = mtf[0];
      tt.fill(byte, outputLength, outputLength + repeat);
      counts[byte] += repeat;
      outputLength += repeat;
      if (value === eob) break;
    }

    const mtfIndex = value - 1;
    if (mtfIndex < 0 || mtfIndex >= mtf.length) {
      throw new Error(`invalid bzip2 MTF index ${mtfIndex}`);
    }
    const byte = mtf[mtfIndex];
    for (let cursor = mtfIndex; cursor > 0; cursor--) {
      mtf[cursor] = mtf[cursor - 1];
    }
    mtf[0] = byte;

    if (outputLength >= blockSize) {
      throw new Error("bzip2 data exceeds block size");
    }
    tt[outputLength++] = byte;
    counts[byte]++;
    value = nextSymbol();
  }

  if (origPtr >= outputLength) {
    throw new Error("bzip2 origPtr is outside the decoded block");
  }

  const preRle = tt.subarray(0, outputLength);
  let cumulative = 0;
  for (let byte = 0; byte < 256; byte++) {
    const count = counts[byte];
    counts[byte] = cumulative;
    cumulative += count;
  }
  for (let index = 0; index < outputLength; index++) {
    const byte = preRle[index] & 0xff;
    const target = counts[byte]++;
    preRle[target] |= index << 8;
  }

  let tPos = preRle[origPtr] >>> 8;
  const output: number[] = [];
  let lastByte = -1;
  let repeats = 0;
  for (let index = 0; index < outputLength; index++) {
    const packed = preRle[tPos];
    const byte = packed & 0xff;
    tPos = packed >>> 8;

    if (repeats === 4) {
      for (let count = 0; count < byte; count++) output.push(lastByte);
      repeats = 0;
      lastByte = -1;
      continue;
    }

    output.push(byte);
    if (byte === lastByte) {
      repeats++;
    } else {
      lastByte = byte;
      repeats = 1;
    }
  }

  return {
    output: Uint8Array.from(output),
    nextBit: bits.position,
    endOfStream: false,
    storedCrc,
  };
}

function buildHuffmanTable(lengths: Uint8Array): HuffmanTable {
  let minLength = MAX_CODE_LENGTH + 1;
  let maxLength = 0;
  for (const length of lengths) {
    if (length < minLength) minLength = length;
    if (length > maxLength) maxLength = length;
  }
  if (minLength < 1 || maxLength > MAX_CODE_LENGTH) {
    throw new Error("invalid bzip2 Huffman length range");
  }

  const perm = new Int32Array(lengths.length);
  let permIndex = 0;
  for (let length = minLength; length <= maxLength; length++) {
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      if (lengths[symbol] === length) perm[permIndex++] = symbol;
    }
  }

  const base = new Int32Array(MAX_CODE_LENGTH + 2);
  const limit = new Int32Array(MAX_CODE_LENGTH + 1);
  for (const length of lengths) base[length + 1]++;
  for (let index = 1; index < base.length; index++) {
    base[index] += base[index - 1];
  }

  let code = 0;
  for (let length = minLength; length <= maxLength; length++) {
    code += base[length + 1] - base[length];
    limit[length] = code - 1;
    code <<= 1;
  }
  for (let length = minLength + 1; length <= maxLength; length++) {
    base[length] = ((limit[length - 1] + 1) << 1) - base[length];
  }

  return { minLength, maxLength, limit, base, perm };
}

function decodeHuffman(bits: BitReader, table: HuffmanTable): number {
  let length = table.minLength;
  let code = bits.readBits(length);
  while (length <= table.maxLength && code > table.limit[length]) {
    length++;
    if (length > table.maxLength) break;
    code = (code << 1) | bits.readBit();
  }
  if (length > table.maxLength) {
    throw new Error("invalid bzip2 Huffman code");
  }

  const index = code - table.base[length];
  if (index < 0 || index >= table.perm.length) {
    throw new Error("invalid bzip2 Huffman symbol index");
  }
  return table.perm[index];
}
