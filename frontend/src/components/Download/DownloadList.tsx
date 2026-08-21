import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Modal from "../common/Modal";
import ProgressBar from "../common/ProgressBar";
import Spinner from "../common/Spinner";
import ConfirmModal from "../common/ConfirmModal";
import EmptyState from "../common/EmptyState";
import LoadingState from "../common/LoadingState";
import { SearchIcon } from "../common/icons";
import DownloadItem from "./DownloadItem";
import {
  isDownloadPreviewEnabled,
  previewDownloadTasks,
} from "./previewTasks";
import { useDownloads } from "../../hooks/useDownloads";
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useToastStore } from "../../store/toast";
import { lookupApp } from "../../api/search";
import { isNewerVersion } from "../../utils/version";
import { storeIdToCountry } from "../../apple/config";
import type { DownloadTask } from "../../types";

type StatusFilter = "all" | DownloadTask["status"];

const STATUS_FILTERS: StatusFilter[] = [
  "all",
  "downloading",
  "injecting",
  "pending",
  "paused",
  "completed",
  "failed",
];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function DownloadList() {
  const { t } = useTranslation();
  const location = useLocation();
  const {
    tasks,
    loading,
    pauseDownload,
    resumeDownload,
    deleteDownload,
    deleteDownloads,
    hashToEmail,
  } = useDownloads();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [managing, setManaging] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
  const [pendingDeleteActiveCount, setPendingDeleteActiveCount] = useState(0);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const addToast = useToastStore((s) => s.addToast);
  const { accounts } = useAccounts();
  const { startDownload } = useDownloadAction();
  const previewEnabled = isDownloadPreviewEnabled(location.search);
  const displayTasks = previewEnabled ? previewDownloadTasks : tasks;

  const [checkingAll, setCheckingAll] = useState(false);
  const cancelCheckRef = useRef(false);
  const [checkProgress, setCheckProgress] = useState({
    current: 0,
    total: 0,
    appName: "",
  });

  useEffect(() => {
    return () => {
      cancelCheckRef.current = true;
    };
  }, []);

  useEffect(() => {
    const validIds = new Set(displayTasks.map((task) => task.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [displayTasks]);

  const statusCounts = useMemo(() => {
    const counts = new Map<StatusFilter, number>();
    counts.set("all", displayTasks.length);
    for (const status of STATUS_FILTERS.slice(1)) {
      counts.set(
        status,
        displayTasks.filter((task) => task.status === status).length,
      );
    }
    return counts;
  }, [displayTasks]);

  const sortedTasks = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const list = displayTasks.filter((task) => {
      if (filter !== "all" && task.status !== filter) return false;
      if (!normalizedQuery) return true;

      const searchableText = [
        task.software.name,
        task.software.artistName,
        task.software.bundleID,
        task.software.version,
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      return searchableText.includes(normalizedQuery);
    });

    return [...list].sort((a, b) => {
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return timeB - timeA;
    });
  }, [displayTasks, filter, searchQuery]);

  useEffect(() => {
    if (!managing) return;
    const visibleIds = new Set(sortedTasks.map((task) => task.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [managing, sortedTasks, selectedIds]);

  const selectedTasks = useMemo(
    () => sortedTasks.filter((task) => selectedIds.has(task.id)),
    [sortedTasks, selectedIds],
  );
  const selectedActiveCount = selectedTasks.filter(
    (task) =>
      task.status === "downloading" ||
      task.status === "injecting" ||
      task.status === "pending",
  ).length;
  const allVisibleSelected =
    sortedTasks.length > 0 && sortedTasks.every((task) => selectedIds.has(task.id));

  const showPreviewNotice = useCallback(() => {
    addToast(
      t("downloads.preview.actionHint"),
      "info",
      t("downloads.preview.badge"),
    );
  }, [addToast, t]);

  function handlePause(id: string) {
    if (previewEnabled) {
      showPreviewNotice();
      return;
    }
    pauseDownload(id);
  }

  function handleResume(id: string) {
    if (previewEnabled) {
      showPreviewNotice();
      return;
    }
    resumeDownload(id);
  }

  function toggleManageMode() {
    if (previewEnabled) {
      showPreviewNotice();
      return;
    }
    setManaging((current) => {
      if (current) setSelectedIds(new Set());
      return !current;
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        sortedTasks.forEach((task) => next.delete(task.id));
      } else {
        sortedTasks.forEach((task) => next.add(task.id));
      }
      return next;
    });
  }

  function openDeleteConfirmation() {
    if (selectedIds.size === 0 || deletingSelected) return;
    setPendingDeleteIds([...selectedIds]);
    setPendingDeleteActiveCount(selectedActiveCount);
    setConfirmBatchDelete(true);
  }

  function closeDeleteConfirmation() {
    if (deletingSelected) return;
    setConfirmBatchDelete(false);
    setPendingDeleteIds([]);
    setPendingDeleteActiveCount(0);
  }

  async function confirmDeleteSelected() {
    if (pendingDeleteIds.length === 0 || deletingSelected) return;
    const idsToDelete = [...pendingDeleteIds];
    setDeletingSelected(true);
    try {
      const result = await deleteDownloads(idsToDelete);

      if (result.deletedIds.length > 0) {
        addToast(
          t("downloads.batchDeleteSuccess", { count: result.deletedIds.length }),
          "success",
          t("toast.title.deleteSuccess"),
        );
      }

      setConfirmBatchDelete(false);
      setPendingDeleteIds([]);
      setPendingDeleteActiveCount(0);

      if (result.failedIds.length === 0) {
        setSelectedIds(new Set());
        setManaging(false);
      } else {
        setSelectedIds(new Set(result.failedIds));
        addToast(
          t("downloads.batchDeleteFailed"),
          "error",
          t("downloads.package.delete"),
        );
      }
    } catch {
      addToast(
        t("downloads.batchDeleteFailed"),
        "error",
        t("downloads.package.delete"),
      );
    } finally {
      setDeletingSelected(false);
    }
  }

  function handleCancelCheck() {
    cancelCheckRef.current = true;
    setCheckingAll(false);
  }

  async function handleCheckAllUpdates() {
    if (previewEnabled) {
      showPreviewNotice();
      return;
    }

    cancelCheckRef.current = false;
    setCheckingAll(true);
    addToast(t("downloads.checkUpdatesStarted"), "info");
    let count = 0;
    const completedTasks = tasks.filter((t) => t.status === "completed");

    setCheckProgress({ current: 0, total: completedTasks.length, appName: "" });

    for (let i = 0; i < completedTasks.length; i++) {
      if (cancelCheckRef.current) break;

      const task = completedTasks[i];
      const accountEmail = hashToEmail[task.accountHash];
      const account = accounts.find((a) => a.email === accountEmail);

      setCheckProgress((prev) => ({ ...prev, appName: task.software.name }));

      if (!account) {
        setCheckProgress((prev) => ({ ...prev, current: i + 1 }));
        continue;
      }

      try {
        await delay(1500);
        if (cancelCheckRef.current) break;

        const country = storeIdToCountry(account.store) ?? "US";
        const latestApp = await lookupApp(task.software.bundleID, country);

        if (
          latestApp &&
          isNewerVersion(latestApp.version, task.software.version)
        ) {
          await startDownload(account, latestApp);
          await deleteDownload(task.id);
          count++;
        }
      } catch {
        // 单个应用检查失败不影响后续
      }

      setCheckProgress((prev) => ({ ...prev, current: i + 1 }));
    }

    if (!cancelCheckRef.current) {
      await delay(500);
      if (!cancelCheckRef.current) {
        setCheckingAll(false);
        addToast(
          count > 0
            ? t("downloads.checkUpdatesCompleted", { count })
            : t("downloads.checkUpdatesNone"),
          "success",
        );
      }
    }
  }

  const emptyBecauseSearch = searchQuery.trim().length > 0;
  const deleteConfirmMessage =
    pendingDeleteActiveCount > 0
      ? t("downloads.batchDeleteConfirmActive", {
          count: pendingDeleteIds.length,
          activeCount: pendingDeleteActiveCount,
        })
      : t("downloads.batchDeleteConfirm", { count: pendingDeleteIds.length });

  return (
    <PageContainer>
      <div className="mb-6 grid grid-cols-2 items-start gap-2 min-[360px]:grid-cols-3 sm:mb-7 sm:grid-cols-6">
        <h1 className="col-span-2 min-w-0 text-[2rem] font-semibold leading-[1.12] tracking-[-0.035em] text-gray-900 min-[360px]:col-span-1 sm:col-span-4 sm:text-[2.125rem] dark:text-white">
          {t("downloads.title")}
        </h1>
        <button
          onClick={handleCheckAllUpdates}
          disabled={checkingAll || managing}
          className="flex h-9 w-full min-w-0 items-center justify-center rounded-full bg-emerald-100 px-2.5 text-center text-[clamp(0.75rem,3.6vw,0.875rem)] font-semibold leading-tight text-emerald-800 transition-colors hover:bg-emerald-200 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400 disabled:hover:bg-gray-100 dark:bg-emerald-900/60 dark:text-emerald-300 dark:hover:bg-emerald-900 dark:disabled:bg-gray-800 dark:disabled:text-gray-600 dark:disabled:hover:bg-gray-800"
        >
          {checkingAll
            ? t("downloads.checkingUpdates")
            : t("downloads.checkUpdates")}
        </button>
        <Link
          to="/downloads/add"
          aria-disabled={managing}
          tabIndex={managing ? -1 : undefined}
          onClick={(event) => managing && event.preventDefault()}
          className={`flex h-9 w-full min-w-0 items-center justify-center rounded-full px-2.5 text-center text-[clamp(0.75rem,3.6vw,0.875rem)] font-semibold leading-tight transition-colors ${
            managing
              ? "pointer-events-none cursor-not-allowed bg-gray-200 text-gray-400 ring-1 ring-gray-300/80 dark:bg-gray-800/50 dark:text-gray-600 dark:ring-white/5"
              : "bg-blue-600 text-white hover:bg-blue-700"
          }`}
        >
          {t("downloads.new")}
        </Link>
      </div>

      <div
        className="mb-4 -mx-1 flex min-w-0 flex-nowrap gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="group"
        aria-label={t("downloads.title")}
      >
        {STATUS_FILTERS.map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`flex h-9 shrink-0 items-center justify-center rounded-full px-3 text-center text-sm font-semibold leading-tight transition-colors ${
              filter === status
                ? "bg-blue-600 text-white"
                : "bg-white text-gray-600 shadow-sm ring-1 ring-black/5 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:ring-white/10 dark:hover:bg-gray-800"
            }`}
          >
            <span>{t(`downloads.status.${status}`)}</span>
            <span
              className={`ml-1.5 text-xs ${
                filter === status
                  ? "text-blue-100"
                  : "text-gray-400 dark:text-gray-500"
              }`}
            >
              {statusCounts.get(status) ?? 0}
            </span>
          </button>
        ))}
      </div>

      <div className="mb-5 flex min-w-0 gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t("downloads.searchDownloaded")}</span>
          <SearchIcon
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            strokeWidth={2}
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("downloads.searchDownloaded")}
            className="h-10 w-full rounded-full bg-white pl-10 pr-4 text-sm text-gray-900 shadow-sm ring-1 ring-black/5 outline-none transition focus:ring-2 focus:ring-blue-500/50 dark:bg-gray-900 dark:text-white dark:ring-white/10"
          />
        </label>
        <button
          type="button"
          onClick={toggleManageMode}
          disabled={!managing && displayTasks.length === 0}
          className={`h-10 shrink-0 rounded-full px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            managing
              ? "bg-blue-600 text-white hover:bg-blue-700"
              : "bg-white text-gray-700 shadow-sm ring-1 ring-black/5 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-200 dark:ring-white/10 dark:hover:bg-gray-800"
          }`}
        >
          {managing ? t("downloads.doneManaging") : t("downloads.manage")}
        </button>
      </div>

      {managing && (
        <div className="mb-5 flex min-w-0 items-center justify-between gap-3 rounded-2xl bg-blue-50 px-3.5 py-2.5 text-sm dark:bg-blue-950/40">
          <span className="min-w-0 truncate font-medium text-blue-800 dark:text-blue-300">
            {t("downloads.selectedCount", { count: selectedIds.size })}
          </span>
          <button
            type="button"
            onClick={toggleSelectAllVisible}
            disabled={sortedTasks.length === 0}
            className="shrink-0 rounded-full px-2 py-1 font-semibold text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-40 dark:text-blue-300 dark:hover:bg-blue-950"
          >
            {allVisibleSelected
              ? t("downloads.deselectAll")
              : t("downloads.selectAll")}
          </button>
        </div>
      )}

      <div
        role="note"
        aria-label={t("downloads.warning")}
        title={t("downloads.warning")}
        className="mb-5 min-w-0 max-w-full overflow-hidden rounded-2xl bg-amber-50 px-2.5 py-3 text-center leading-relaxed text-amber-800 ring-1 ring-amber-200/70 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-800/50"
      >
        <span
          aria-hidden="true"
          className="block whitespace-nowrap text-[clamp(0.625rem,3.1vw,0.75rem)] xl:hidden"
        >
          {t("downloads.warningShort")}
        </span>
        <span
          aria-hidden="true"
          className="hidden whitespace-nowrap text-xs xl:block"
        >
          {t("downloads.warning")}
        </span>
      </div>

      {previewEnabled && (
        <div className="mb-5 flex min-w-0 items-start gap-3 rounded-2xl border border-blue-200/80 bg-blue-50/90 px-4 py-3 text-sm leading-6 text-blue-800 shadow-sm shadow-blue-950/5 dark:border-blue-900/70 dark:bg-blue-950/45 dark:text-blue-300 dark:shadow-none">
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full bg-blue-600 px-2 text-[10px] font-semibold uppercase tracking-wide text-white"
          >
            {t("downloads.preview.badge")}
          </span>
          <p className="min-w-0 leading-5">
            {t("downloads.preview.description")}
          </p>
        </div>
      )}

      {loading && displayTasks.length === 0 ? (
        <LoadingState label={t("downloads.loading")} />
      ) : sortedTasks.length === 0 ? (
        <EmptyState
          icon={
            <svg
              className="h-8 w-8 text-blue-600 dark:text-blue-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
              />
            </svg>
          }
          title={
            emptyBecauseSearch
              ? t("downloads.noSearchResults")
              : filter === "all"
                ? t("downloads.emptyAll")
                : t("downloads.emptyFilter", {
                    status: t(`downloads.status.${filter}`),
                  })
          }
          description={
            emptyBecauseSearch
              ? t("downloads.noSearchResultsDesc")
              : filter === "all"
                ? t("downloads.emptyAllDesc")
                : t("downloads.emptyFilterDesc")
          }
          action={
            filter === "all" && !emptyBecauseSearch ? (
              <Link
                to="/search"
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              >
                <SearchIcon className="h-4 w-4" strokeWidth={2.5} />
                {t("downloads.searchApps")}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className={`space-y-3 ${managing ? "pb-24" : ""}`}>
          {sortedTasks.map((task) => (
            <DownloadItem
              key={task.id}
              task={task}
              preview={previewEnabled}
              managing={managing}
              selected={selectedIds.has(task.id)}
              onToggleSelect={toggleSelected}
              onPause={handlePause}
              onResume={handleResume}
            />
          ))}
        </div>
      )}

      {managing && selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 px-4 md:left-auto md:right-6 md:bottom-6 md:w-80 md:px-0">
          <button
            type="button"
            onClick={openDeleteConfirmation}
            disabled={deletingSelected}
            className="min-h-12 w-full rounded-full bg-red-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-red-950/20 transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("downloads.deleteSelected", { count: selectedIds.size })}
          </button>
        </div>
      )}

      <Modal
        open={checkingAll && checkProgress.total > 0}
        onClose={handleCancelCheck}
        title={t("downloads.checkingUpdates")}
      >
        <div className="space-y-4">
          <div className="flex justify-center text-blue-600 dark:text-blue-400">
            <Spinner />
          </div>
          <div className="text-center">
            <p className="truncate text-sm text-gray-600 dark:text-gray-400">
              {checkProgress.appName
                ? `${t("downloads.checkingApp")}${checkProgress.appName}`
                : "..."}
            </p>
            <p className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">
              {checkProgress.current} / {checkProgress.total}
            </p>
          </div>
          <ProgressBar
            label={t("downloads.checkingUpdates")}
            progress={
              checkProgress.total > 0
                ? (checkProgress.current / checkProgress.total) * 100
                : 0
            }
          />
          <p className="text-center text-xs text-gray-400 dark:text-gray-500">
            {t("downloads.checkUpdatesDesc")}
          </p>
          <div className="flex justify-center">
            <button
              onClick={handleCancelCheck}
              className="min-h-11 rounded-full bg-gray-100 px-5 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {t("settings.data.cancel")}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={confirmBatchDelete}
        title={t("downloads.package.delete")}
        message={deleteConfirmMessage}
        confirmText={t("accounts.detail.confirmDelete")}
        danger
        loading={deletingSelected}
        onConfirm={() => void confirmDeleteSelected()}
        onCancel={closeDeleteConfirmation}
      />
    </PageContainer>
  );
}
