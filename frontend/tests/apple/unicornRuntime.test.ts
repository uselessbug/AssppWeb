import { describe, expect, it, vi } from "vitest";
import {
  runUnicornX64SmokeTest,
  type UnicornX86Module,
} from "../../src/apple/sap/unicornRuntime";

describe("apple/sap/unicornRuntime", () => {
  it("executes the x86_64 smoke test contract", async () => {
    const memMap = vi.fn();
    const memWrite = vi.fn();
    const memRead = vi.fn(() => new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const emuStart = vi.fn();
    const close = vi.fn();

    class FakeUnicorn {
      mem_map = memMap;
      mem_write = memWrite;
      mem_read = memRead;
      emu_start = emuStart;
      reg_read_i64 = vi.fn(() => 0x1122334455667788n);
      close = close;
    }

    const module = {
      ARCH_X86: 4,
      MODE_64: 8,
      PROT_ALL: 7,
      X86_REG_RAX: 35,
      Unicorn: FakeUnicorn,
    } as unknown as UnicornX86Module;

    await expect(runUnicornX64SmokeTest(module)).resolves.toEqual({
      version: "2.1.4",
      rax: "0x1122334455667788",
      highAddressRoundTrip: true,
    });

    expect(memMap).toHaveBeenNthCalledWith(1, 0x100000, 0x1000, 7);
    expect(memMap).toHaveBeenNthCalledWith(
      2,
      0x0000300000000000,
      0x1000,
      7,
    );
    expect(memWrite).toHaveBeenCalledTimes(2);
    expect(memRead).toHaveBeenCalledWith(0x0000300000000000, 4);
    expect(emuStart).toHaveBeenCalledWith(0x100000, 0x10000b, 0, 0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the engine if the register result is unexpected", async () => {
    const close = vi.fn();

    class FakeUnicorn {
      mem_map = vi.fn();
      mem_write = vi.fn();
      mem_read = vi.fn(() => new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
      emu_start = vi.fn();
      reg_read_i64 = vi.fn(() => 1n);
      close = close;
    }

    const module = {
      ARCH_X86: 4,
      MODE_64: 8,
      PROT_ALL: 7,
      X86_REG_RAX: 35,
      Unicorn: FakeUnicorn,
    } as unknown as UnicornX86Module;

    await expect(runUnicornX64SmokeTest(module)).rejects.toThrow(
      "Unicorn x86_64 smoke test returned RAX=0x1",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
