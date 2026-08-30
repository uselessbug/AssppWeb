import { createServer } from "http";
import AdmZip from "adm-zip";
import plist from "plist";
import { afterEach, describe, expect, it } from "vitest";
import { readRemoteIpaVersionMetadata } from "../src/services/remoteIpaMetadata.js";

const servers: ReturnType<typeof createServer>[] = [];

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_SIGNATURE = 0x06054b50;
const UINT32_MAX = 0xffffffff;

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function serveRanges(data: Buffer): Promise<{
  url: string;
  fullRequests: () => number;
}> {
  let fullRequestCount = 0;
  const server = createServer((req, res) => {
    const range = req.headers.range;
    if (!range) {
      fullRequestCount++;
      res.statusCode = 200;
      res.end(data);
      return;
    }

    const match = range.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) {
      res.statusCode = 416;
      res.end();
      return;
    }

    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), data.length - 1);
    if (start < 0 || start >= data.length || end < start) {
      res.statusCode = 416;
      res.end();
      return;
    }

    const body = data.subarray(start, end + 1);
    res.statusCode = 206;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Range", `bytes ${start}-${end}/${data.length}`);
    res.setHeader("Content-Length", String(body.length));
    res.end(body);
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");

  return {
    url: `http://127.0.0.1:${address.port}/test.ipa`,
    fullRequests: () => fullRequestCount,
  };
}

function makeZip64Ipa(): Buffer {
  const filename = Buffer.from("Payload/Test.app/Info.plist");
  const body = Buffer.from(
    plist.build({
      CFBundleShortVersionString: "9.1.2",
      releaseDate: "2026-08-20T01:02:03Z",
    }),
  );

  const localZip64Extra = Buffer.alloc(20);
  localZip64Extra.writeUInt16LE(0x0001, 0);
  localZip64Extra.writeUInt16LE(16, 2);
  localZip64Extra.writeBigUInt64LE(BigInt(body.length), 4);
  localZip64Extra.writeBigUInt64LE(BigInt(body.length), 12);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
  localHeader.writeUInt16LE(45, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(UINT32_MAX, 18);
  localHeader.writeUInt32LE(UINT32_MAX, 22);
  localHeader.writeUInt16LE(filename.length, 26);
  localHeader.writeUInt16LE(localZip64Extra.length, 28);

  const localRecord = Buffer.concat([
    localHeader,
    filename,
    localZip64Extra,
    body,
  ]);
  const directoryOffset = localRecord.length;

  const centralZip64Extra = Buffer.alloc(28);
  centralZip64Extra.writeUInt16LE(0x0001, 0);
  centralZip64Extra.writeUInt16LE(24, 2);
  centralZip64Extra.writeBigUInt64LE(BigInt(body.length), 4);
  centralZip64Extra.writeBigUInt64LE(BigInt(body.length), 12);
  centralZip64Extra.writeBigUInt64LE(0n, 20);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  centralHeader.writeUInt16LE(45, 4);
  centralHeader.writeUInt16LE(45, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(UINT32_MAX, 20);
  centralHeader.writeUInt32LE(UINT32_MAX, 24);
  centralHeader.writeUInt16LE(filename.length, 28);
  centralHeader.writeUInt16LE(centralZip64Extra.length, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(UINT32_MAX, 42);

  const directory = Buffer.concat([centralHeader, filename, centralZip64Extra]);
  const zip64EocdOffset = directoryOffset + directory.length;

  const zip64Eocd = Buffer.alloc(56);
  zip64Eocd.writeUInt32LE(ZIP64_EOCD_SIGNATURE, 0);
  zip64Eocd.writeBigUInt64LE(44n, 4);
  zip64Eocd.writeUInt16LE(45, 12);
  zip64Eocd.writeUInt16LE(45, 14);
  zip64Eocd.writeUInt32LE(0, 16);
  zip64Eocd.writeUInt32LE(0, 20);
  zip64Eocd.writeBigUInt64LE(1n, 24);
  zip64Eocd.writeBigUInt64LE(1n, 32);
  zip64Eocd.writeBigUInt64LE(BigInt(directory.length), 40);
  zip64Eocd.writeBigUInt64LE(BigInt(directoryOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(ZIP64_EOCD_LOCATOR_SIGNATURE, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
  locator.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(UINT32_MAX, 12);
  eocd.writeUInt32LE(UINT32_MAX, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localRecord, directory, zip64Eocd, locator, eocd]);
}

describe("readRemoteIpaVersionMetadata", () => {
  it("reads version metadata with range requests only", async () => {
    const zip = new AdmZip();
    zip.addFile(
      "Payload/Test.app/Info.plist",
      Buffer.from(
        plist.build({
          CFBundleShortVersionString: "8.0.61",
          releaseDate: "2026-08-12T10:20:30Z",
        }),
      ),
    );
    zip.addFile("Payload/Test.app/Filler.bin", Buffer.alloc(128 * 1024, 7));
    const ipa = zip.toBuffer();
    const server = await serveRanges(ipa);

    await expect(readRemoteIpaVersionMetadata(server.url)).resolves.toEqual({
      displayVersion: "8.0.61",
      releaseDate: "2026-08-12T10:20:30.000Z",
    });
    expect(server.fullRequests()).toBe(0);
  });

  it("reads ZIP64 central-directory metadata without downloading the full IPA", async () => {
    const server = await serveRanges(makeZip64Ipa());

    await expect(readRemoteIpaVersionMetadata(server.url)).resolves.toEqual({
      displayVersion: "9.1.2",
      releaseDate: "2026-08-20T01:02:03.000Z",
    });
    expect(server.fullRequests()).toBe(0);
  });
});
