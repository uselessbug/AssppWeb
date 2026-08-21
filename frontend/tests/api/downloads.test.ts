import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteDownload } from "../../src/api/downloads";

describe("downloads api deletion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a 404 delete response as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Download not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      deleteDownload("stale-task", "account-hash"),
    ).resolves.toBeUndefined();
  });

  it("still rejects non-404 delete failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(deleteDownload("task-1", "account-hash")).rejects.toThrow(
      "Server error",
    );
  });
});
