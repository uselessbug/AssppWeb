import {
  BrowserUnicornCodeHook,
  BrowserUnicornEngine,
  SAP_HEAP_BASE,
  SAP_HEAP_SIZE,
  SAP_PAGE_SIZE,
  SAP_SHIM_BASE,
} from "./unicornEngine";

const SHIM_CODE_SIZE = 0x00080000;
const SHIM_SIZE = 0x00100000;
const SHIM_SLOT_SIZE = 16;
const SHIM_RET = 0xc3;
const MAX_GUEST_TRANSFER = 64 << 20;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT32_MAX = 0xffffffffn;
const FAKE_HANDLE = UINT64_MAX;
const CORE_FP_FILE = 3n;
const CORE_FP_PATH = "/System/Library/PrivateFrameworks/CoreFP.framework/CoreFP";
const ICXS_PATH = "./../CoreFP.icxs";
const KEY_SERIAL = "IOPlatformSerialNumber";
const KEY_UUID = "IOPlatformUUID";
const KEY_BOARD = "board-id";
const KEYED_MESSAGE = "objectForKey:";
const MEMORY_CHUNK_SIZE = 64 << 10;

type ShimHandler = () => void;

interface ShimEntry {
  name: string;
  handler: ShimHandler;
}

interface GuestAllocation {
  size: number;
  reserved: number;
}

interface FreeBlock {
  address: number;
  size: number;
}

export interface SapShimSummary {
  imports: number;
  firstAddress: number;
  lastAddress: number;
}

export class BrowserSapShimTable {
  private readonly addresses = new Map<string, number>();
  private readonly entries = new Map<number, ShimEntry>();
  private readonly resolvedImports = new Set<string>();
  private readonly allocations = new Map<number, GuestAllocation>();
  private freeBlocks: FreeBlock[] = [];
  private nextOffset = 0;
  private dataCursor = SAP_SHIM_BASE + SHIM_CODE_SIZE;
  private hook?: BrowserUnicornCodeHook;
  private fault?: Error;
  private errnoAddress = 0;
  private heapCursor = 0;
  private iterator = 0;
  private icxsOffset = 0;

  constructor(
    private readonly engine: BrowserUnicornEngine,
    private readonly coreExports: ReadonlyMap<string, number>,
    private readonly icxs: Uint8Array,
  ) {
    this.registerMemoryServices();
    this.registerPlatformServices();
    this.hook = this.engine.addCodeHook(
      SAP_SHIM_BASE,
      SAP_SHIM_BASE + SHIM_CODE_SIZE - 1,
      (address) => this.dispatch(address),
    );
  }

  resolve(name: string): number {
    if (!name) throw new Error("SAP guest import name is empty");
    this.resolvedImports.add(name);

    const existing = this.addresses.get(name);
    if (existing !== undefined) return existing;

    return this.addFunction(name, () => {
      throw new Error(`guest called unsupported import ${name}`);
    });
  }

  resetFault() {
    this.fault = undefined;
  }

  getFault(): Error | undefined {
    return this.fault;
  }

  close() {
    this.hook?.close();
    this.hook = undefined;
  }

  summary(): SapShimSummary {
    const imports = this.resolvedImports.size;
    const addresses = Array.from(this.resolvedImports, (name) =>
      this.addresses.get(name),
    ).filter((address): address is number => address !== undefined);
    return {
      imports,
      firstAddress:
        addresses.length === 0 ? SAP_SHIM_BASE : Math.min(...addresses),
      lastAddress:
        addresses.length === 0 ? SAP_SHIM_BASE : Math.max(...addresses),
    };
  }

  names(): string[] {
    return Array.from(this.resolvedImports).sort();
  }

  private registerMemoryServices() {
    this.addAliases(["_malloc"], () => this.malloc());
    this.addAliases(["_malloc_good_size"], () => this.mallocGoodSize());
    this.addAliases(["_malloc_size"], () => this.mallocSize());
    this.addAliases(["_calloc"], () => this.calloc());
    this.addAliases(["_realloc", "_reallocf"], () => this.realloc());
    this.addAliases(["_free"], () => this.free());
    this.addAliases(["_memcpy", "_memmove"], () => this.memmove());
    this.addAliases(["_memset"], () => this.memset());
    this.addAliases(["___bzero"], () => this.bzero());
    this.addAliases(["___memcpy_chk"], () => this.checkedMemcpy());
    this.addAliases(["___memset_chk"], () => this.checkedMemset());
    this.addAliases(["_memcmp"], () => this.memcmp());
    this.addAliases(["_strcmp"], () => this.strcmp());
    this.addAliases(["_strncmp"], () => this.strncmp());
    this.addAliases(["_strlen"], () => this.strlen());
  }

  private registerPlatformServices() {
    this.addAliases(
      [
        "_CFBundleGetMainBundle",
        "_CFDataGetBytePtr",
        "_CFDataGetLength",
        "_CFStringGetLength",
        "_CFStringGetMaximumSizeForEncoding",
        "_CFUUIDCreateString",
        "_IORegistryEntryFromPath",
        "_IORegistryEntrySearchCFProperty",
        "_IOServiceMatching",
        "_getenv",
        "_pthread_self",
      ],
      () => this.setResult(0n),
    );
    this.addAliases(
      [
        "_CFDictionaryGetValue",
        "_DADiskCopyDescription",
        "_DADiskCreateFromBSDName",
        "_DASessionCreate",
        "_IORegistryEntryCreateCFProperty",
      ],
      () => this.setResult(FAKE_HANDLE),
    );
    this.addAliases(
      [
        "_CFRelease",
        "_IOObjectRelease",
        "_close",
        "_close$UNIX2003",
        "_pthread_mutex_lock",
        "_pthread_mutex_unlock",
        "_pthread_rwlock_init",
        "_pthread_rwlock_init$UNIX2003",
        "_pthread_rwlock_unlock",
        "_pthread_rwlock_unlock$UNIX2003",
        "_pthread_rwlock_wrlock",
        "_pthread_rwlock_wrlock$UNIX2003",
      ],
      () => this.setResult(0n),
    );
    this.addAliases(["_CFStringCreateWithCString"], () => this.cfStringCreate());
    this.addAliases(["_CFStringCreateWithCStringNoCopy"], () => this.setResult(0n));
    this.addAliases(["_CFStringGetCString"], () => this.cfStringGetCString());
    this.addAliases(["_IOIteratorNext"], () => this.ioIteratorNext());
    this.addAliases(["_IORegistryEntryGetParentEntry"], () =>
      this.ioRegistryEntryGetParentEntry(),
    );
    this.addAliases(["_IOServiceGetMatchingServices"], () =>
      this.ioServiceGetMatchingServices(),
    );
    this.addAliases(["_IOServiceGetMatchingService"], () =>
      this.setResult(UINT32_MAX),
    );
    this.addAliases(["_OSAtomicCompareAndSwap32Barrier"], () =>
      this.compareAndSwap32(),
    );
    this.addAliases(["___error"], () => this.setResult(this.errnoAddress));
    this.addAliases(["_abort", "___stack_chk_fail", "dyld_stub_binder"], () => {
      throw new Error("guest aborted");
    });
    this.addAliases(["_arc4random"], () => this.arc4random());
    this.addAliases(["_dlopen"], () => this.dlopen());
    this.addAliases(["_dlsym"], () => this.dlsym());
    this.addAliases(
      ["_fcntl", "_fcntl$UNIX2003", "_lstat$INODE64", "_statfs", "_statfs$INODE64"],
      () => this.setResult(UINT64_MAX),
    );
    this.addAliases(["_gettimeofday"], () => this.gettimeofday());
    this.addAliases(["_objc_msgSend"], () => this.objcMsgSend());
    this.addAliases(["_open", "_open$UNIX2003"], () => this.openFile());
    this.addAliases(["_pthread_once"], () => this.pthreadOnce());
    this.addAliases(["_read", "_read$UNIX2003"], () => this.readFile());
    this.addAliases(["_sysctl"], () => this.setResult(UINT64_MAX));
    this.addAliases(["_sysctlbyname"], () => this.sysctlbyname());

    this.errnoAddress = this.addData("guest.errno", new Uint8Array(8));
    this.addData(
      "___stack_chk_guard",
      new Uint8Array([0xa5, 0x71, 0x3c, 0xd9, 0x86, 0x42, 0xef, 0x10]),
    );
    for (const name of [
      "_kCFAllocatorDefault",
      "_kCFAllocatorNull",
      "_kDADiskDescriptionVolumeUUIDKey",
      "_kIOMasterPortDefault",
    ]) {
      this.addData(name, new Uint8Array(8));
    }
  }

  private dispatch(address: number) {
    const entry = this.entries.get(address);
    if (!entry) {
      this.fail(new Error(`guest entered unknown service address 0x${address.toString(16)}`));
      return;
    }

    try {
      entry.handler();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(new Error(`${entry.name}: ${message}`));
    }
  }

  private fail(error: Error) {
    if (!this.fault) this.fault = error;
    try {
      this.engine.stop();
    } catch (stopError) {
      if (!this.fault) {
        this.fault =
          stopError instanceof Error ? stopError : new Error(String(stopError));
      }
    }
  }

  private addAliases(names: string[], handler: ShimHandler) {
    for (const name of names) this.addFunction(name, handler);
  }

  private addFunction(name: string, handler: ShimHandler): number {
    const existing = this.addresses.get(name);
    if (existing !== undefined) return existing;
    if (this.nextOffset + SHIM_SLOT_SIZE > SHIM_CODE_SIZE) {
      throw new Error("SAP shim code area is exhausted");
    }

    const address = SAP_SHIM_BASE + this.nextOffset;
    this.nextOffset += SHIM_SLOT_SIZE;
    const stub = new Uint8Array(SHIM_SLOT_SIZE);
    stub[0] = SHIM_RET;
    this.engine.memWrite(address, stub);
    this.entries.set(address, { name, handler });
    this.addresses.set(name, address);
    return address;
  }

  private addData(name: string, data: Uint8Array): number {
    const existing = this.addresses.get(name);
    if (existing !== undefined) return existing;

    this.dataCursor = align(this.dataCursor, 8);
    if (this.dataCursor + data.length > SAP_SHIM_BASE + SHIM_SIZE) {
      throw new Error("SAP shim data area is exhausted");
    }

    const address = this.dataCursor;
    this.dataCursor += Math.max(data.length, 8);
    if (data.length !== 0) this.engine.memWrite(address, data);
    this.addresses.set(name, address);
    return address;
  }

  private argument(index: number): bigint {
    const registers = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"] as const;
    if (!Number.isInteger(index) || index < 0) {
      throw new Error("negative or invalid guest argument index");
    }
    if (index < registers.length) return this.engine.regRead(registers[index]);

    const stack = this.safeNumber(this.engine.regRead("rsp"), "guest stack pointer");
    return this.readUint64(stack + 8 + (index - registers.length) * 8);
  }

  private setResult(value: bigint | number) {
    const normalized = typeof value === "bigint" ? value : BigInt(value);
    this.engine.regWrite("rax", BigInt.asUintN(64, normalized));
  }

  private setSignedResult(value: number) {
    this.setResult(BigInt.asUintN(64, BigInt(value)));
  }

  private readUint32(address: number): number {
    const data = this.engine.memRead(address, 4);
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  }

  private writeUint32(address: number, value: number) {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setUint32(0, value >>> 0, true);
    this.engine.memWrite(address, data);
  }

  private readUint64(address: number): bigint {
    const data = this.engine.memRead(address, 8);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return BigInt(view.getUint32(0, true)) | (BigInt(view.getUint32(4, true)) << 32n);
  }

  private writeUint64(address: number, value: bigint | number) {
    const normalized = BigInt.asUintN(
      64,
      typeof value === "bigint" ? value : BigInt(value),
    );
    const data = new Uint8Array(8);
    const view = new DataView(data.buffer);
    view.setUint32(0, Number(normalized & 0xffffffffn), true);
    view.setUint32(4, Number((normalized >> 32n) & 0xffffffffn), true);
    this.engine.memWrite(address, data);
  }

  private readCStringBytes(address: number): Uint8Array {
    const maximum = 4096;
    const value: number[] = [];
    while (value.length < maximum) {
      const item = this.engine.memRead(address + value.length, 1)[0];
      if (item === 0) return Uint8Array.from(value);
      value.push(item);
    }
    throw new Error(`guest string exceeds ${maximum} bytes`);
  }

  private readCString(address: number): string {
    return new TextDecoder().decode(this.readCStringBytes(address));
  }

  private checkedSize(value: bigint, label = "guest transfer"): number {
    if (value < 0n || value > BigInt(MAX_GUEST_TRANSFER)) {
      throw new Error(`${label} size ${value.toString()} exceeds limit`);
    }
    return Number(value);
  }

  private safeNumber(value: bigint, label: string): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} 0x${value.toString(16)} exceeds guest safe address range`);
    }
    return Number(value);
  }

  private malloc() {
    const address = this.allocate(this.argument(0));
    this.setResult(address);
  }

  private mallocGoodSize() {
    const size = this.checkedSize(this.argument(0), "allocation");
    this.setResult(align(Math.max(size, 1), 16));
  }

  private mallocSize() {
    const address = this.safeNumber(this.argument(0), "malloc pointer");
    this.setResult(this.allocations.get(address)?.reserved ?? 0);
  }

  private calloc() {
    const count = this.argument(0);
    const size = this.argument(1);
    const total = count * size;
    if (total > BigInt(MAX_GUEST_TRANSFER)) {
      throw new Error("allocation size overflows or exceeds limit");
    }
    const address = this.allocate(total);
    this.fillMemory(address, Number(total), 0);
    this.setResult(address);
  }

  private realloc() {
    const oldAddressValue = this.argument(0);
    const newSizeValue = this.argument(1);
    if (oldAddressValue === 0n) {
      this.setResult(this.allocate(newSizeValue));
      return;
    }

    const oldAddress = this.safeNumber(oldAddressValue, "realloc pointer");
    const newSize = this.checkedSize(newSizeValue, "allocation");
    const oldAllocation = this.allocations.get(oldAddress);
    if (!oldAllocation) {
      throw new Error(`reallocate unknown pointer 0x${oldAddress.toString(16)}`);
    }

    if (newSize <= oldAllocation.reserved) {
      oldAllocation.size = newSize;
      this.allocations.set(oldAddress, oldAllocation);
      this.setResult(oldAddress);
      return;
    }

    const newAddress = this.allocate(BigInt(newSize));
    const data = this.engine.memRead(oldAddress, oldAllocation.size);
    this.engine.memWrite(newAddress, data);
    this.release(oldAddress);
    this.setResult(newAddress);
  }

  private free() {
    const addressValue = this.argument(0);
    if (addressValue !== 0n) {
      this.release(this.safeNumber(addressValue, "free pointer"));
    }
    this.setResult(0n);
  }

  private allocate(sizeValue: bigint): number {
    const size = this.checkedSize(sizeValue, "allocation");
    const reserved = align(Math.max(size, 1), 16);

    for (let index = 0; index < this.freeBlocks.length; index++) {
      const block = this.freeBlocks[index];
      if (block.size < reserved) continue;

      const address = block.address;
      if (block.size === reserved) {
        this.freeBlocks.splice(index, 1);
      } else {
        block.address += reserved;
        block.size -= reserved;
      }
      this.allocations.set(address, { size, reserved });
      return address;
    }

    if (this.heapCursor + reserved > SAP_HEAP_SIZE) {
      throw new Error("guest heap exhausted");
    }
    const address = SAP_HEAP_BASE + this.heapCursor;
    this.heapCursor += reserved;
    this.allocations.set(address, { size, reserved });
    return address;
  }

  private release(address: number) {
    const allocation = this.allocations.get(address);
    if (!allocation) {
      throw new Error(`free unknown pointer 0x${address.toString(16)}`);
    }

    this.fillMemory(address, allocation.reserved, 0);
    this.allocations.delete(address);
    this.freeBlocks.push({ address, size: allocation.reserved });
    this.coalesceFreeBlocks();
  }

  private coalesceFreeBlocks() {
    this.freeBlocks.sort((left, right) => left.address - right.address);
    const merged: FreeBlock[] = [];
    for (const block of this.freeBlocks) {
      const last = merged[merged.length - 1];
      if (last && last.address + last.size === block.address) {
        last.size += block.size;
      } else {
        merged.push({ ...block });
      }
    }
    this.freeBlocks = merged;

    while (this.freeBlocks.length !== 0) {
      const last = this.freeBlocks[this.freeBlocks.length - 1];
      if (last.address + last.size !== SAP_HEAP_BASE + this.heapCursor) break;
      this.heapCursor -= last.size;
      this.freeBlocks.pop();
    }
  }

  private memmove() {
    const destination = this.safeNumber(this.argument(0), "memmove destination");
    const source = this.safeNumber(this.argument(1), "memmove source");
    const length = this.checkedSize(this.argument(2));
    const data = this.engine.memRead(source, length);
    this.engine.memWrite(destination, data);
    this.setResult(destination);
  }

  private memset() {
    const destination = this.safeNumber(this.argument(0), "memset destination");
    const value = Number(this.argument(1) & 0xffn);
    const length = this.checkedSize(this.argument(2));
    this.fillMemory(destination, length, value);
    this.setResult(destination);
  }

  private bzero() {
    const destination = this.safeNumber(this.argument(0), "bzero destination");
    const length = this.checkedSize(this.argument(1));
    this.fillMemory(destination, length, 0);
    this.setResult(destination);
  }

  private checkedMemcpy() {
    const length = this.argument(2);
    const capacity = this.argument(3);
    if (length > capacity) throw new Error("checked copy exceeds destination");
    this.memmove();
  }

  private checkedMemset() {
    const length = this.argument(2);
    const capacity = this.argument(3);
    if (length > capacity) throw new Error("checked fill exceeds destination");
    this.memset();
  }

  private memcmp() {
    const left = this.safeNumber(this.argument(0), "memcmp left");
    const right = this.safeNumber(this.argument(1), "memcmp right");
    const length = this.checkedSize(this.argument(2));
    const a = this.engine.memRead(left, length);
    const b = this.engine.memRead(right, length);
    let result = 0;
    for (let index = 0; index < length; index++) {
      if (a[index] !== b[index]) {
        result = a[index] - b[index];
        break;
      }
    }
    this.setSignedResult(result);
  }

  private strcmp() {
    const left = this.safeNumber(this.argument(0), "strcmp left");
    const right = this.safeNumber(this.argument(1), "strcmp right");
    const a = this.readCStringBytes(left);
    const b = this.readCStringBytes(right);
    this.setSignedResult(compareBytes(a, b));
  }

  private strncmp() {
    const left = this.safeNumber(this.argument(0), "strncmp left");
    const right = this.safeNumber(this.argument(1), "strncmp right");
    const length = this.checkedSize(this.argument(2));

    let offset = 0;
    while (offset < length) {
      const chunk = Math.min(
        length - offset,
        SAP_PAGE_SIZE - ((left + offset) % SAP_PAGE_SIZE),
        SAP_PAGE_SIZE - ((right + offset) % SAP_PAGE_SIZE),
      );
      const a = this.engine.memRead(left + offset, chunk);
      const b = this.engine.memRead(right + offset, chunk);
      for (let index = 0; index < chunk; index++) {
        if (a[index] !== b[index]) {
          this.setSignedResult(a[index] - b[index]);
          return;
        }
        if (a[index] === 0) {
          this.setResult(0n);
          return;
        }
      }
      offset += chunk;
    }
    this.setResult(0n);
  }

  private strlen() {
    const address = this.safeNumber(this.argument(0), "strlen pointer");
    this.setResult(this.readCStringBytes(address).length);
  }

  private cfStringCreate() {
    const address = this.safeNumber(this.argument(1), "CFString input");
    const value = this.readCString(address);
    this.setResult(
      value === KEY_SERIAL || value === KEY_UUID || value === KEY_BOARD
        ? FAKE_HANDLE
        : 0n,
    );
  }

  private cfStringGetCString() {
    const bufferValue = this.argument(1);
    const capacity = this.argument(2);
    if (bufferValue === 0n || capacity === 0n) {
      this.setResult(0n);
      return;
    }
    const buffer = this.safeNumber(bufferValue, "CFString output");
    this.engine.memWrite(buffer, new Uint8Array([0]));
    this.setResult(1n);
  }

  private ioIteratorNext() {
    this.iterator++;
    this.setResult(this.iterator % 2);
  }

  private ioRegistryEntryGetParentEntry() {
    const parent = this.safeNumber(this.argument(2), "registry parent output");
    if (parent === 0) throw new Error("parent registry entry output is null");
    this.writeUint32(parent, 0xffffffff);
    this.setResult(0n);
  }

  private ioServiceGetMatchingServices() {
    const iterator = this.safeNumber(this.argument(2), "matching services output");
    if (iterator === 0) throw new Error("matching services iterator output is null");
    this.iterator = 0;
    this.writeUint32(iterator, 0xffffffff);
    this.setResult(0n);
  }

  private compareAndSwap32() {
    const oldValue = Number(this.argument(0) & 0xffffffffn);
    const newValue = Number(this.argument(1) & 0xffffffffn);
    const address = this.safeNumber(this.argument(2), "atomic value pointer");
    if (this.readUint32(address) !== oldValue) {
      this.setResult(0n);
      return;
    }
    this.writeUint32(address, newValue);
    this.setResult(1n);
  }

  private arc4random() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    this.setResult(new DataView(bytes.buffer).getUint32(0, true));
  }

  private dlopen() {
    const pathAddress = this.safeNumber(this.argument(0), "dlopen path");
    this.setResult(this.readCString(pathAddress) === CORE_FP_PATH ? FAKE_HANDLE : 0n);
  }

  private dlsym() {
    const nameAddress = this.safeNumber(this.argument(1), "dlsym name");
    const name = this.readCString(nameAddress);
    this.setResult(this.coreExports.get(`_${name}`) ?? 0);
  }

  private gettimeofday() {
    const timeAddressValue = this.argument(0);
    const zoneAddressValue = this.argument(1);
    const nowMs = Date.now();
    const seconds = BigInt(Math.floor(nowMs / 1000));
    const micros = Math.floor((nowMs % 1000) * 1000);

    if (timeAddressValue !== 0n) {
      const address = this.safeNumber(timeAddressValue, "timeval pointer");
      const data = new Uint8Array(16);
      const view = new DataView(data.buffer);
      view.setUint32(0, Number(seconds & 0xffffffffn), true);
      view.setUint32(4, Number((seconds >> 32n) & 0xffffffffn), true);
      view.setUint32(8, micros, true);
      this.engine.memWrite(address, data);
    }

    if (zoneAddressValue !== 0n) {
      const address = this.safeNumber(zoneAddressValue, "timezone pointer");
      this.engine.memWrite(address, new Uint8Array(8));
    }
    this.setResult(0n);
  }

  private objcMsgSend() {
    const selectorAddress = this.safeNumber(this.argument(1), "Objective-C selector");
    const selector = this.readCString(selectorAddress);
    this.setResult(selector === KEYED_MESSAGE ? FAKE_HANDLE : 0n);
  }

  private openFile() {
    const pathAddress = this.safeNumber(this.argument(0), "open path");
    const path = this.readCString(pathAddress);
    if (path === ICXS_PATH) {
      this.icxsOffset = 0;
      this.setResult(CORE_FP_FILE);
      return;
    }
    this.setResult(UINT64_MAX);
  }

  private pthreadOnce() {
    const control = this.safeNumber(this.argument(0), "pthread_once control");
    const initializer = this.argument(1);
    if (this.readUint64(control) === 0n) {
      this.setResult(0n);
      return;
    }

    this.writeUint64(control, 0n);
    const stack = this.safeNumber(this.engine.regRead("rsp"), "pthread_once stack");
    const nextStack = stack - 8;
    this.writeUint64(nextStack, initializer);
    this.engine.regWrite("rsp", nextStack);
    this.setResult(0n);
  }

  private readFile() {
    const descriptor = this.argument(0);
    const buffer = this.safeNumber(this.argument(1), "read buffer");
    const requested = this.checkedSize(this.argument(2));
    if (descriptor !== CORE_FP_FILE) {
      this.setResult(UINT64_MAX);
      return;
    }

    const remaining = this.icxs.length - this.icxsOffset;
    const size = Math.min(requested, remaining);
    if (size !== 0) {
      this.engine.memWrite(
        buffer,
        this.icxs.subarray(this.icxsOffset, this.icxsOffset + size),
      );
      this.icxsOffset += size;
    }
    this.setResult(size);
  }

  private sysctlbyname() {
    const lengthAddressValue = this.argument(2);
    if (lengthAddressValue !== 0n) {
      const address = this.safeNumber(lengthAddressValue, "sysctl length output");
      this.writeUint64(address, 0n);
    }
    this.setResult(0n);
  }

  private fillMemory(address: number, length: number, value: number) {
    if (length === 0) return;
    const chunkSize = Math.min(length, MEMORY_CHUNK_SIZE);
    const chunk = new Uint8Array(chunkSize);
    if (value !== 0) chunk.fill(value & 0xff);

    let offset = 0;
    while (offset < length) {
      const count = Math.min(chunk.length, length - offset);
      this.engine.memWrite(
        address + offset,
        count === chunk.length ? chunk : chunk.subarray(0, count),
      );
      offset += count;
    }
  }
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}
