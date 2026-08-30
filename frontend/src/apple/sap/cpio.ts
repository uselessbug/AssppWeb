const CPIO_HEADER_SIZE = 76;
const CPIO_NAME_SIZE_OFFSET = 59;
const CPIO_FILE_SIZE_OFFSET = 65;
const CPIO_MAGIC = "070707";
const CPIO_TRAILER = "TRAILER!!!";
const MAX_CPIO_NAME_SIZE = 4096;

export interface SapAssetSpec {
  name: "CommerceKit" | "CommerceCore" | "CoreFP" | "CoreFP.icxs";
  path: string;
  size: number;
  sha256: string;
}

export const SAP_ASSET_SPECS: readonly SapAssetSpec[] = [
  {
    name: "CommerceKit",
    path: "./System/Library/PrivateFrameworks/CommerceKit.framework/Versions/A/CommerceKit",
    size: 3_271_840,
    sha256: "b84ff12c21987856c0a17b78f1ad82b73195a6dec5f3b208a17d245555a2c8a2",
  },
  {
    name: "CommerceCore",
    path: "./System/Library/PrivateFrameworks/CommerceKit.framework/Versions/A/Frameworks/CommerceCore.framework/Versions/A/CommerceCore",
    size: 207_744,
    sha256: "c5401e57402230f3c876409d295319ddf1e61287bc882683c5d61277be7bc1f2",
  },
  {
    name: "CoreFP",
    path: "./System/Library/PrivateFrameworks/CoreFP.framework/Versions/A/CoreFP",
    size: 29_014_912,
    sha256: "f19141336be4198d0f8991bb00017c915efc7aeaece36c345f7faa1237ea6074",
  },
  {
    name: "CoreFP.icxs",
    path: "./System/Library/PrivateFrameworks/CoreFP.framework/Versions/A/CoreFP.icxs",
    size: 5_288_352,
    sha256: "473e78af86979f5bd4f6269561caf770b3d16c098d918846eeac8cdd2fe6566a",
  },
] as const;

export interface AppleSapAssetBundle {
  CommerceKit: Uint8Array;
  CommerceCore: Uint8Array;
  CoreFP: Uint8Array;
  CoreFPICXS: Uint8Array;
}

type CollectorState = "header" | "name" | "body" | "done";

class ByteQueue {
  private chunks: Uint8Array[] = [];
  private offset = 0;
  length = 0;

  push(chunk: Uint8Array) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  read(size: number): Uint8Array | undefined {
    if (size < 0 || this.length < size) return undefined;
    const output = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      const current = this.chunks[0];
      const available = current.length - this.offset;
      const take = Math.min(size - written, available);
      output.set(current.subarray(this.offset, this.offset + take), written);
      written += take;
      this.offset += take;
      this.length -= take;
      if (this.offset === current.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return output;
  }

  discard(size: number): number {
    let remaining = Math.min(size, this.length);
    const discarded = remaining;
    while (remaining > 0) {
      const current = this.chunks[0];
      const available = current.length - this.offset;
      const take = Math.min(remaining, available);
      remaining -= take;
      this.offset += take;
      this.length -= take;
      if (this.offset === current.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return discarded;
  }
}

export class SapCpioCollector {
  private readonly queue = new ByteQueue();
  private readonly wanted = new Map(SAP_ASSET_SPECS.map((spec) => [spec.path, spec]));
  private readonly found = new Map<SapAssetSpec["name"], Uint8Array>();
  private state: CollectorState = "header";
  private skippedPrefix = 0;
  private nameSize = 0;
  private bodyRemaining = 0;
  private currentSpec: SapAssetSpec | undefined;
  private currentOutput: Uint8Array | undefined;
  private currentWritten = 0;

  constructor(private readonly prefixBytesToSkip: number) {}

  get complete() {
    return this.found.size === SAP_ASSET_SPECS.length;
  }

  feed(chunk: Uint8Array) {
    if (this.state === "done" || chunk.length === 0) return;
    this.queue.push(chunk);
    this.process();
  }

  finish(): AppleSapAssetBundle {
    if (!this.complete) {
      const missing = SAP_ASSET_SPECS
        .filter((spec) => !this.found.has(spec.name))
        .map((spec) => spec.name)
        .join(", ");
      throw new Error(`Apple SAP CPIO ended before required assets were found: ${missing}`);
    }

    return {
      CommerceKit: this.found.get("CommerceKit")!,
      CommerceCore: this.found.get("CommerceCore")!,
      CoreFP: this.found.get("CoreFP")!,
      CoreFPICXS: this.found.get("CoreFP.icxs")!,
    };
  }

  private process() {
    while (true) {
      if (this.skippedPrefix < this.prefixBytesToSkip) {
        const count = this.queue.discard(this.prefixBytesToSkip - this.skippedPrefix);
        this.skippedPrefix += count;
        if (this.skippedPrefix < this.prefixBytesToSkip) return;
      }

      if (this.state === "header") {
        const header = this.queue.read(CPIO_HEADER_SIZE);
        if (!header) return;
        const magic = new TextDecoder().decode(header.subarray(0, CPIO_MAGIC.length));
        if (magic !== CPIO_MAGIC) {
          throw new Error(`invalid Apple SAP CPIO magic ${JSON.stringify(magic)}`);
        }
        this.nameSize = parseOctal(header.subarray(CPIO_NAME_SIZE_OFFSET, CPIO_FILE_SIZE_OFFSET));
        this.bodyRemaining = parseOctal(header.subarray(CPIO_FILE_SIZE_OFFSET, CPIO_HEADER_SIZE));
        if (this.nameSize < 1 || this.nameSize > MAX_CPIO_NAME_SIZE) {
          throw new Error(`invalid Apple SAP CPIO name size ${this.nameSize}`);
        }
        this.state = "name";
      }

      if (this.state === "name") {
        const nameBytes = this.queue.read(this.nameSize);
        if (!nameBytes) return;
        if (nameBytes[nameBytes.length - 1] !== 0) {
          throw new Error("Apple SAP CPIO name is not NUL-terminated");
        }
        const path = new TextDecoder().decode(nameBytes.subarray(0, -1));
        if (path === CPIO_TRAILER) {
          this.state = "done";
          return;
        }

        this.currentSpec = this.wanted.get(path);
        this.currentWritten = 0;
        this.currentOutput = undefined;
        if (this.currentSpec) {
          if (this.bodyRemaining !== this.currentSpec.size) {
            throw new Error(
              `Apple SAP asset ${this.currentSpec.name} has CPIO size ${this.bodyRemaining}, expected ${this.currentSpec.size}`,
            );
          }
          this.currentOutput = new Uint8Array(this.currentSpec.size);
        }
        this.state = "body";
      }

      if (this.state === "body") {
        if (this.bodyRemaining === 0) {
          this.commitBody();
          continue;
        }
        if (this.queue.length === 0) return;
        const take = Math.min(this.bodyRemaining, this.queue.length);
        const data = this.queue.read(take)!;
        if (this.currentOutput) {
          this.currentOutput.set(data, this.currentWritten);
          this.currentWritten += data.length;
        }
        this.bodyRemaining -= data.length;
        if (this.bodyRemaining === 0) {
          this.commitBody();
          continue;
        }
        return;
      }

      return;
    }
  }

  private commitBody() {
    if (this.currentSpec && this.currentOutput) {
      if (this.found.has(this.currentSpec.name)) {
        throw new Error(`Apple SAP CPIO contains duplicate ${this.currentSpec.name}`);
      }
      this.found.set(this.currentSpec.name, this.currentOutput);
    }
    this.currentSpec = undefined;
    this.currentOutput = undefined;
    this.currentWritten = 0;
    this.state = this.complete ? "done" : "header";
  }
}

export async function validateSapAssetBundle(bundle: AppleSapAssetBundle) {
  const files: Record<SapAssetSpec["name"], Uint8Array> = {
    CommerceKit: bundle.CommerceKit,
    CommerceCore: bundle.CommerceCore,
    CoreFP: bundle.CoreFP,
    "CoreFP.icxs": bundle.CoreFPICXS,
  };

  for (const spec of SAP_ASSET_SPECS) {
    const data = files[spec.name];
    if (data.length !== spec.size) {
      throw new Error(
        `Apple SAP asset ${spec.name} has size ${data.length}, expected ${spec.size}`,
      );
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const actual = bytesToHex(digest);
    if (actual !== spec.sha256) {
      throw new Error(`Apple SAP asset ${spec.name} failed SHA-256 verification`);
    }
  }
}

function parseOctal(input: Uint8Array): number {
  const text = new TextDecoder().decode(input);
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`invalid Apple SAP CPIO octal value ${JSON.stringify(text)}`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Apple SAP CPIO value exceeds JavaScript safe integer range");
  }
  return value;
}

function bytesToHex(input: Uint8Array): string {
  return Array.from(input, (value) => value.toString(16).padStart(2, "0")).join("");
}
