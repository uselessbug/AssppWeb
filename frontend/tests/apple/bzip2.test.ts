import { describe, expect, it } from "vitest";
import { decodeBzip2Block } from "../../src/apple/sap/bzip2";

describe("browser SAP bzip2 decoder", () => {
  it("decodes a raw BZh9 block without the BZh9 file header", () => {
    const compressed = hexToBytes(
      "425a68393141592653590ba572920001f419804000408006449080200070400c04d550f5189aa906658d54835520c1419ba906ea41ed520e54837520e5483f1772453850900ba57292",
    );
    const rawBlocks = compressed.subarray(4);
    const chunks: Uint8Array[] = [];

    const block = decodeBzip2Block(rawBlocks, 0, (chunk) => chunks.push(chunk));
    expect(block.endOfStream).toBe(false);

    const output = concat(chunks);
    const expected = new TextEncoder().encode(`070707${"hello world".repeat(1000)}`);
    expect(output).toEqual(expected);

    const end = decodeBzip2Block(rawBlocks, block.nextBit, () => {
      throw new Error("end marker emitted unexpected data");
    });
    expect(end.endOfStream).toBe(true);
  });
});

function hexToBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index++) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
