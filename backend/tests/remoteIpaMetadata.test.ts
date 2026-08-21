import { createServer } from 'http';
import AdmZip from 'adm-zip';
import plist from 'plist';
import { afterEach, describe, expect, it } from 'vitest';
import { readRemoteIpaVersionMetadata } from '../src/services/remoteIpaMetadata.js';

const servers: ReturnType<typeof createServer>[] = [];

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
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');

  return {
    url: `http://127.0.0.1:${address.port}/test.ipa`,
    fullRequests: () => fullRequestCount,
  };
}

describe('readRemoteIpaVersionMetadata', () => {
  it('reads version metadata with range requests only', async () => {
    const zip = new AdmZip();
    zip.addFile(
      'Payload/Test.app/Info.plist',
      Buffer.from(
        plist.build({
          CFBundleShortVersionString: '8.0.61',
          releaseDate: '2026-08-12T10:20:30Z',
        }),
      ),
    );
    zip.addFile('Payload/Test.app/Filler.bin', Buffer.alloc(128 * 1024, 7));
    const ipa = zip.toBuffer();
    const server = await serveRanges(ipa);

    await expect(readRemoteIpaVersionMetadata(server.url)).resolves.toEqual({
      displayVersion: '8.0.61',
      releaseDate: '2026-08-12T10:20:30.000Z',
    });
    expect(server.fullRequests()).toBe(0);
  });
});
