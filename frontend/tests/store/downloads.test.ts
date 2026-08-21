import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  useDownloadsStore,
  __resetPollStateForTests,
} from "../../src/store/downloads";
import * as downloadsApi from "../../src/api/downloads";
import type { DownloadTask } from "../../src/types";

vi.mock("../../src/api/downloads", () => ({
  fetchDownloads: vi.fn(),
  startDownload: vi.fn(),
  pauseDownload: vi.fn(),
  resumeDownload: vi.fn(),
  deleteDownload: vi.fn(),
}));

const mockedFetch = vi.mocked(downloadsApi.fetchDownloads);
const mockedStart = vi.mocked(downloadsApi.startDownload);
const mockedDelete = vi.mocked(downloadsApi.deleteDownload);

function makeTask(partial: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: "task-1",
    software: {
      id: 1,
      bundleID: "com.example.app",
      name: "Example App",
      version: "1.0",
      artistName: "Example",
      sellerName: "Example",
      description: "",
      averageUserRating: 0,
      userRatingCount: 0,
      artworkUrl: "",
      screenshotUrls: [],
      minimumOsVersion: "12.0",
      releaseDate: "2026-01-01",
      primaryGenreName: "Utilities",
    },
    accountHash: "account-hash",
    status: "downloading",
    progress: 0,
    speed: "0 B/s",
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe("downloads store", () => {
  beforeEach(() => {
    __resetPollStateForTests();
    useDownloadsStore.setState({
      tasks: [],
      loading: false,
      accountHashes: [],
    });
    vi.useFakeTimers();
    mockedFetch.mockReset();
    mockedStart.mockReset();
    mockedDelete.mockReset();
  });

  afterEach(() => {
    __resetPollStateForTests();
    vi.useRealTimers();
  });

  describe("polling", () => {
    it("shares an overlapping fetch while a request is in flight", async () => {
      let resolveFetch!: (value: DownloadTask[]) => void;
      mockedFetch.mockImplementationOnce(
        () =>
          new Promise<DownloadTask[]>((resolve) => {
            resolveFetch = resolve;
          }),
      );

      const first = useDownloadsStore.getState().fetchTasks();
      const second = useDownloadsStore.getState().fetchTasks();
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);

      resolveFetch([makeTask()]);
      await first;
      await second;
      expect(useDownloadsStore.getState().tasks).toHaveLength(1);
    });

    it("refetches with new account hashes after an older request finishes", async () => {
      const task = makeTask({ status: "completed" });
      let resolveOldFetch!: (value: DownloadTask[]) => void;
      mockedFetch
        .mockImplementationOnce(
          () =>
            new Promise<DownloadTask[]>((resolve) => {
              resolveOldFetch = resolve;
            }),
        )
        .mockResolvedValueOnce([task]);

      useDownloadsStore.getState().setAccountHashes(["old-hash"]);
      const oldFetch = useDownloadsStore.getState().fetchTasks();
      useDownloadsStore.getState().setAccountHashes(["new-hash"]);
      const newFetch = useDownloadsStore.getState().fetchTasks();

      resolveOldFetch([]);
      await oldFetch;
      await newFetch;

      expect(mockedFetch).toHaveBeenNthCalledWith(1, ["old-hash"]);
      expect(mockedFetch).toHaveBeenNthCalledWith(2, ["new-hash"]);
      expect(useDownloadsStore.getState().tasks).toEqual([task]);
    });

    it("ignores a polling snapshot started before a successful deletion", async () => {
      const task = makeTask({ status: "completed" });
      useDownloadsStore.setState({ tasks: [task] });
      let resolveFetch!: (value: DownloadTask[]) => void;
      mockedFetch.mockImplementationOnce(
        () =>
          new Promise<DownloadTask[]>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      mockedDelete.mockResolvedValueOnce(undefined);

      const poll = useDownloadsStore.getState().fetchTasks();
      await useDownloadsStore.getState().deleteDownloads([task.id]);
      expect(useDownloadsStore.getState().tasks).toEqual([]);

      resolveFetch([task]);
      await poll;
      expect(useDownloadsStore.getState().tasks).toEqual([]);
    });

    it("waits for a deletion before starting a new polling snapshot", async () => {
      const task = makeTask({ status: "completed" });
      useDownloadsStore.setState({ tasks: [task] });
      let resolveDelete!: () => void;
      mockedDelete.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveDelete = resolve;
          }),
      );
      mockedFetch.mockResolvedValueOnce([]);

      const deletion = useDownloadsStore.getState().deleteDownloads([task.id]);
      const poll = useDownloadsStore.getState().fetchTasks();
      expect(mockedFetch).not.toHaveBeenCalled();

      resolveDelete();
      await deletion;
      await poll;

      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(useDownloadsStore.getState().tasks).toEqual([]);
    });

    it("performs a fresh fetch after creating a task during an older poll", async () => {
      const task = makeTask({ status: "pending" });
      let resolveOldFetch!: (value: DownloadTask[]) => void;
      mockedFetch
        .mockImplementationOnce(
          () =>
            new Promise<DownloadTask[]>((resolve) => {
              resolveOldFetch = resolve;
            }),
        )
        .mockResolvedValueOnce([task]);
      mockedStart.mockResolvedValueOnce(task);

      const oldPoll = useDownloadsStore.getState().fetchTasks();
      const creation = useDownloadsStore.getState().startDownload({
        software: task.software,
        accountHash: task.accountHash,
        downloadURL: "https://example.test/app.ipa",
        sinfs: [],
        iTunesMetadata: "metadata",
      });

      resolveOldFetch([]);
      await oldPoll;
      await creation;

      expect(mockedFetch).toHaveBeenCalledTimes(2);
      expect(useDownloadsStore.getState().tasks).toEqual([task]);
    });

    it("backs off after failures and restores the normal interval on success", async () => {
      useDownloadsStore.setState({ tasks: [makeTask()] });
      mockedFetch.mockResolvedValue([makeTask()]);
      mockedFetch.mockRejectedValueOnce(new Error("network down"));

      await useDownloadsStore.getState().fetchTasks();
      expect(mockedFetch).toHaveBeenCalledTimes(1);

      // 首次失败后退避到 4s：3s 时不应重试
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1001);
      expect(mockedFetch).toHaveBeenCalledTimes(2);

      // 成功后恢复 2s 正常轮询间隔
      await vi.advanceTimersByTimeAsync(2001);
      expect(mockedFetch).toHaveBeenCalledTimes(3);
    });

    it("stops polling when there are no active tasks left", async () => {
      useDownloadsStore.setState({ tasks: [makeTask()] });
      mockedFetch.mockResolvedValue([makeTask({ status: "completed" })]);

      await useDownloadsStore.getState().fetchTasks();
      expect(mockedFetch).toHaveBeenCalledTimes(1);

      // 无活跃任务后不应继续轮询
      vi.advanceTimersByTime(10_000);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("batch deletion", () => {
    it("removes successful deletes and keeps failed tasks selected for retry", async () => {
      const task1 = makeTask({ id: "task-1", status: "completed" });
      const task2 = makeTask({ id: "task-2", status: "completed" });
      useDownloadsStore.setState({ tasks: [task1, task2], accountHashes: [] });

      mockedDelete.mockImplementation(async (id) => {
        if (id === "task-2") throw new Error("server error");
      });

      const result = await useDownloadsStore
        .getState()
        .deleteDownloads(["task-1", "task-2"]);

      expect(result).toEqual({
        deletedIds: ["task-1"],
        failedIds: ["task-2"],
      });
      expect(useDownloadsStore.getState().tasks.map((task) => task.id)).toEqual([
        "task-2",
      ]);
    });

    it("reconciles a failed delete with the authoritative server list", async () => {
      const task = makeTask({ id: "task-1", status: "completed" });
      useDownloadsStore.setState({
        tasks: [task],
        accountHashes: ["account-hash"],
      });
      mockedDelete.mockRejectedValueOnce(new Error("connection reset"));
      mockedFetch.mockResolvedValueOnce([]);

      const result = await useDownloadsStore
        .getState()
        .deleteDownloads(["task-1"]);

      expect(mockedFetch).toHaveBeenCalledWith(["account-hash"]);
      expect(result).toEqual({ deletedIds: ["task-1"], failedIds: [] });
      expect(useDownloadsStore.getState().tasks).toEqual([]);
    });

    it("treats an already-missing local task as deleted", async () => {
      useDownloadsStore.setState({ tasks: [], accountHashes: [] });

      const result = await useDownloadsStore
        .getState()
        .deleteDownloads(["stale-task"]);

      expect(mockedDelete).not.toHaveBeenCalled();
      expect(result).toEqual({
        deletedIds: ["stale-task"],
        failedIds: [],
      });
    });
  });
});
