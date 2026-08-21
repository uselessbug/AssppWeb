import { create } from "zustand";
import type { DownloadTask, Software, Sinf } from "../types";
import * as downloadsApi from "../api/downloads";

export interface BatchDeleteResult {
  deletedIds: string[];
  failedIds: string[];
}

interface DownloadsState {
  tasks: DownloadTask[];
  loading: boolean;
  accountHashes: string[];
  setAccountHashes: (hashes: string[]) => void;
  fetchTasks: () => Promise<void>;
  startDownload: (data: {
    software: Software;
    accountHash: string;
    downloadURL: string;
    sinfs: Sinf[];
    iTunesMetadata?: string;
  }) => Promise<void>;
  pauseDownload: (id: string) => Promise<void>;
  resumeDownload: (id: string) => Promise<void>;
  deleteDownload: (id: string) => Promise<void>;
  deleteDownloads: (ids: string[]) => Promise<BatchDeleteResult>;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: { promise: Promise<void>; version: number } | null = null;
let mutationVersion = 0;
let activeMutations = 0;
let mutationBarrier: Promise<void> | null = null;
let resolveMutationBarrier: (() => void) | null = null;
let consecutiveErrors = 0;

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 30_000;

function hasActiveTasks(tasks: DownloadTask[]): boolean {
  return tasks.some(
    (t) =>
      t.status === "downloading" ||
      t.status === "pending" ||
      t.status === "injecting",
  );
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

// 轮询采用可变延迟：连续失败时指数退避，避免故障期间高频请求
function schedulePoll() {
  if (pollTimer || isDocumentHidden()) return;
  const backoff = Math.min(2 ** Math.min(consecutiveErrors, 4), 16);
  const delay = Math.min(POLL_INTERVAL_MS * backoff, MAX_POLL_INTERVAL_MS);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void useDownloadsStore.getState().fetchTasks();
  }, delay);
}

function startPolling(immediate = false) {
  if (pollTimer || isDocumentHidden()) return;
  if (immediate) {
    void useDownloadsStore.getState().fetchTasks();
  }
  schedulePoll();
}

function invalidatePendingFetches() {
  mutationVersion += 1;
}

function beginMutation() {
  if (activeMutations === 0) {
    mutationBarrier = new Promise<void>((resolve) => {
      resolveMutationBarrier = resolve;
    });
  }
  activeMutations += 1;
  invalidatePendingFetches();
}

function endMutation() {
  invalidatePendingFetches();
  activeMutations = Math.max(0, activeMutations - 1);
  if (activeMutations !== 0) return;

  const resolve = resolveMutationBarrier;
  mutationBarrier = null;
  resolveMutationBarrier = null;
  resolve?.();
}

async function runMutation<T>(mutation: () => Promise<T>): Promise<T> {
  beginMutation();
  try {
    return await mutation();
  } finally {
    endMutation();
  }
}

// 页面切到后台时暂停轮询，回到前台时立即恢复一次，避免隐藏标签页空转请求
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    const state = useDownloadsStore.getState();
    if (document.hidden) {
      stopPolling();
    } else if (hasActiveTasks(state.tasks)) {
      startPolling(true);
    }
  });
}

// 仅测试使用：重置轮询与变更协调的模块级状态
export function __resetPollStateForTests() {
  stopPolling();
  inFlight = null;
  mutationVersion = 0;
  activeMutations = 0;
  mutationBarrier = null;
  resolveMutationBarrier = null;
  consecutiveErrors = 0;
}

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  tasks: [],
  loading: false,
  accountHashes: [],

  setAccountHashes: (hashes) => {
    invalidatePendingFetches();
    set({ accountHashes: hashes });
  },

  fetchTasks: () => {
    // 变更期间不读取服务端快照，避免 DELETE/POST 尚未落定时取得旧列表。
    if (mutationBarrier) {
      return mutationBarrier.then(() => get().fetchTasks());
    }

    const requestedVersion = mutationVersion;

    // 同一版本共享请求；状态版本已经变化时，等待旧请求结束后再重新读取。
    if (inFlight) {
      if (inFlight.version === requestedVersion) {
        return inFlight.promise;
      }
      return inFlight.promise.then(() => get().fetchTasks());
    }

    const request = (async () => {
      const { accountHashes, tasks } = get();
      // 仅在列表为空时展示全屏 loading，避免轮询刷新时列表闪烁
      if (tasks.length === 0) {
        set({ loading: true });
      }

      try {
        const fetchedTasks = await downloadsApi.fetchDownloads(accountHashes);

        // 请求期间账号、任务或远端变更发生变化时，响应已不是权威快照。
        if (requestedVersion !== mutationVersion) {
          set({ loading: false });
          if (hasActiveTasks(get().tasks)) {
            schedulePoll();
          } else {
            stopPolling();
          }
          return;
        }

        consecutiveErrors = 0;
        set({ tasks: fetchedTasks, loading: false });

        if (hasActiveTasks(fetchedTasks)) {
          schedulePoll();
        } else {
          stopPolling();
        }
      } catch {
        if (requestedVersion === mutationVersion) {
          consecutiveErrors += 1;
        }
        set({ loading: false });
        // 失败时若仍有活跃任务则退避重试，否则停止轮询
        if (hasActiveTasks(get().tasks)) {
          schedulePoll();
        } else {
          stopPolling();
        }
      }
    })();

    const trackedRequest = request.finally(() => {
      if (inFlight?.promise === trackedRequest) {
        inFlight = null;
      }
    });
    inFlight = { promise: trackedRequest, version: requestedVersion };
    return trackedRequest;
  },

  startDownload: async (data) => {
    await runMutation(() => downloadsApi.startDownload(data));
    await get().fetchTasks();
  },

  pauseDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await runMutation(() => downloadsApi.pauseDownload(id, task.accountHash));
    await get().fetchTasks();
  },

  resumeDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await runMutation(() => downloadsApi.resumeDownload(id, task.accountHash));
    await get().fetchTasks();
  },

  deleteDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await runMutation(() => downloadsApi.deleteDownload(id, task.accountHash));
    set({ tasks: get().tasks.filter((t) => t.id !== id) });
  },

  deleteDownloads: async (ids) => {
    const requestedIds = [...new Set(ids)];
    if (requestedIds.length === 0) {
      return { deletedIds: [], failedIds: [] };
    }

    const currentTasks = get().tasks;
    const requestedSet = new Set(requestedIds);
    const selectedTasks = currentTasks.filter((task) => requestedSet.has(task.id));
    const knownIds = new Set(selectedTasks.map((task) => task.id));

    // 本地已经不存在的目标天然满足 DELETE 的最终状态。
    const deletedIds = requestedIds.filter((id) => !knownIds.has(id));
    const failedIds: string[] = [];

    const results = await runMutation(() =>
      Promise.allSettled(
        selectedTasks.map((task) =>
          downloadsApi.deleteDownload(task.id, task.accountHash),
        ),
      ),
    );

    results.forEach((result, index) => {
      const id = selectedTasks[index].id;
      if (result.status === "fulfilled") deletedIds.push(id);
      else failedIds.push(id);
    });

    if (deletedIds.length > 0) {
      const deletedSet = new Set(deletedIds);
      set({ tasks: get().tasks.filter((task) => !deletedSet.has(task.id)) });
    }

    if (failedIds.length === 0 || get().accountHashes.length === 0) {
      return { deletedIds, failedIds };
    }

    // 非 404 的真实失败后，以变更完成后的服务端列表做一次权威对账。
    await get().fetchTasks();
    const remainingIds = new Set(get().tasks.map((task) => task.id));
    const reconciledFailedIds = failedIds.filter((id) => remainingIds.has(id));
    const reconciledDeletedIds = [
      ...deletedIds,
      ...failedIds.filter((id) => !remainingIds.has(id)),
    ];

    return {
      deletedIds: reconciledDeletedIds,
      failedIds: reconciledFailedIds,
    };
  },
}));
