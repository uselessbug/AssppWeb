import { memo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import AppIcon from "../common/AppIcon";
import Badge from "../common/Badge";
import ProgressBar from "../common/ProgressBar";
import PackageQuickActions from "./PackageQuickActions";
import { formatBytes } from "../../utils/format";
import type { DownloadTask } from "../../types";

interface DownloadItemProps {
  task: DownloadTask;
  preview?: boolean;
  managing?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
}

// 轮询每 2s 刷新任务列表，memo 让非活跃任务在父级因弹窗等状态重渲染时跳过
const DownloadItem = memo(function DownloadItem({
  task,
  preview = false,
  managing = false,
  selected = false,
  onToggleSelect,
  onPause,
  onResume,
}: DownloadItemProps) {
  const { t } = useTranslation();

  const isActive = task.status === "downloading" || task.status === "injecting";
  const isPaused = task.status === "paused";
  const detailsHref = `/downloads/${task.id}${
    preview ? "?preview=downloads" : ""
  }`;

  const header = (
    <div className="flex min-w-0 items-start gap-3">
      {managing && (
        <span
          aria-hidden="true"
          className={`mt-4 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
            selected
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-900"
          }`}
        >
          {selected && (
            <svg className="h-3 w-3" viewBox="0 0 20 20" fill="none">
              <path
                d="M4.5 10.5 8 14l7.5-8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      )}
      <AppIcon
        url={task.software.artworkUrl}
        name={task.software.name}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="block truncate text-sm font-semibold text-gray-900 dark:text-white">
              {task.software.name}
            </p>
            <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
              {task.software.artistName}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Badge status={task.status} />
            {!managing && (
              <svg
                aria-hidden="true"
                className="h-4 w-4 text-gray-300 dark:text-gray-600"
                viewBox="0 0 20 20"
                fill="none"
              >
                <path
                  d="m7.5 4.5 5 5.5-5 5.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        </div>
        <p
          title={task.software.bundleID}
          className="mt-1 truncate font-mono text-[11px] text-gray-400 dark:text-gray-500"
        >
          {task.software.bundleID}
        </p>
      </div>
    </div>
  );

  return (
    <article
      className={`min-w-0 rounded-3xl bg-white p-4 shadow-sm ring-1 dark:bg-gray-900 sm:p-5 ${
        managing && selected
          ? "ring-2 ring-blue-500/70 dark:ring-blue-400/70"
          : "ring-black/5 dark:ring-white/10"
      }`}
    >
      {managing ? (
        <button
          type="button"
          onClick={() => onToggleSelect?.(task.id)}
          className="block w-full min-w-0 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          aria-pressed={selected}
          aria-label={t(
            selected ? "downloads.deselectItem" : "downloads.selectItem",
            { name: task.software.name },
          )}
        >
          {header}
        </button>
      ) : (
        <Link
          to={detailsHref}
          className="block min-w-0 rounded-2xl transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        >
          {header}
        </Link>
      )}

      <dl className="mt-3 grid min-w-0 grid-cols-3 gap-2">
        <SummaryItem
          label={t("downloads.package.version")}
          value={task.software.version}
        />
        <SummaryItem
          label={t("downloads.package.size")}
          value={formatBytes(task.software.fileSizeBytes)}
        />
        <SummaryItem
          label={t("downloads.package.minOs")}
          value={`iOS ${task.software.minimumOsVersion || "—"}`}
        />
      </dl>

      {(isActive || isPaused) && (
        <div className="mt-3">
          <ProgressBar progress={task.progress} label={task.software.name} />
          <div className="mt-1.5 flex min-w-0 justify-between gap-3 text-xs font-medium text-gray-500 dark:text-gray-400">
            <span>{Math.round(task.progress)}%</span>
            {task.speed && isActive && (
              <span className="max-w-[55%] truncate text-right">
                {task.speed}
              </span>
            )}
          </div>
        </div>
      )}

      {task.error && (
        <p className="mt-3 break-words rounded-2xl border border-red-200/80 bg-red-50/90 px-3 py-2.5 text-xs font-medium leading-5 text-red-700 shadow-sm shadow-red-950/5 dark:border-red-900/70 dark:bg-red-950/45 dark:text-red-300 dark:shadow-none">
          {task.error}
        </p>
      )}

      {!managing && task.status === "completed" && task.hasFile && (
        <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          <PackageQuickActions task={task} size="compact" />
        </div>
      )}

      {!managing && (isActive || isPaused) && (
        <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          <ActionButton
            onClick={() => (isActive ? onPause(task.id) : onResume(task.id))}
          >
            {isActive
              ? t("downloads.package.pause")
              : t("downloads.package.resume")}
          </ActionButton>
        </div>
      )}
    </article>
  );
});

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-gray-50 px-2.5 py-2 dark:bg-gray-800/60">
      <dt className="truncate text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </dt>
      <dd
        title={value}
        className="mt-0.5 truncate text-xs font-medium text-gray-700 dark:text-gray-200"
      >
        {value}
      </dd>
    </div>
  );
}

function ActionButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-10 w-full min-w-0 rounded-full bg-gray-100 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
    >
      {children}
    </button>
  );
}

export default DownloadItem;
