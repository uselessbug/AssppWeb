import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Modal from "../common/Modal";
import ConfirmModal from "../common/ConfirmModal";
import { useAccountsStore } from "../../store/accounts";
import { useToastStore } from "../../store/toast";
import { apiGet } from "../../api/client";
import { encryptData, decryptData } from "../../utils/crypto";
import type { Account } from "../../types";

interface ServerInfo {
  uptime?: number;
  buildCommit?: string;
  buildDate?: string;
  port?: number;
  dataDir?: string;
  publicBaseUrl?: string;
  disableHttpsRedirect?: boolean;
  autoCleanupDays?: number;
  autoCleanupMaxMB?: number;
  maxDownloadMB?: number;
  downloadThreads?: number;
}

const cardClass =
  "min-w-0 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6";
const fieldClass =
  "block min-h-11 w-full min-w-0 max-w-full truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 transition-colors focus:ring-2 focus:ring-blue-500/40 dark:bg-gray-800 dark:text-white";
const modalFieldClass =
  "block min-h-11 w-full min-w-0 max-w-full rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 transition-colors focus:ring-2 focus:ring-blue-500/40 dark:bg-gray-800 dark:text-white";

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { accounts, addAccount, updateAccount } = useAccountsStore();
  const addToast = useToastStore((s) => s.addToast);

  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirmPassword, setExportConfirmPassword] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [importFileData, setImportFileData] = useState("");

  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [pendingAccounts, setPendingAccounts] = useState<Account[]>([]);
  const [conflictStats, setConflictStats] = useState({ conflict: 0, new: 0 });
  const [showClearModal, setShowClearModal] = useState(false);

  useEffect(() => {
    apiGet<ServerInfo>("/api/settings")
      .then(setServerInfo)
      .catch(() => setServerInfo(null));
  }, []);

  async function handleExport() {
    if (exportPassword !== exportConfirmPassword) {
      addToast(t("settings.data.passwordMismatch"), "error");
      return;
    }
    try {
      const encrypted = await encryptData(accounts, exportPassword);
      const blob = new Blob([encrypted], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "asspp-accounts.enc";
      a.click();
      URL.revokeObjectURL(url);
      setExportModalOpen(false);
      setExportPassword("");
      setExportConfirmPassword("");
      addToast(t("settings.data.exportSuccess"), "success");
    } catch {
      addToast(t("settings.data.exportFailed"), "error");
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setImportFileData(event.target?.result as string);
      setImportModalOpen(true);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function handleImport() {
    try {
      const parsed = await decryptData(importFileData, importPassword);
      if (!Array.isArray(parsed)) throw new Error("Invalid format");
      const valid = parsed.filter(
        (item: any) =>
          item &&
          typeof item === "object" &&
          typeof item.email === "string" &&
          item.email.length > 0,
      ) as Account[];
      if (valid.length === 0) throw new Error("No valid accounts found");

      if (accounts.length === 0) {
        for (const acc of valid) await addAccount(acc);
        addToast(t("settings.data.importSuccess"), "success");
        setImportModalOpen(false);
        setImportPassword("");
        return;
      }

      let conflictCount = 0;
      let newCount = 0;
      valid.forEach((imported) => {
        if (accounts.some((a) => a.email === imported.email)) conflictCount++;
        else newCount++;
      });
      if (conflictCount > 0) {
        setConflictStats({ conflict: conflictCount, new: newCount });
        setPendingAccounts(valid);
        setImportModalOpen(false);
        setImportPassword("");
        setConflictModalOpen(true);
      } else {
        for (const acc of valid) await addAccount(acc);
        addToast(t("settings.data.importSuccess"), "success");
        setImportModalOpen(false);
        setImportPassword("");
      }
    } catch {
      addToast(t("settings.data.incorrectPassword"), "error");
    }
  }

  async function handleResolveConflict(overwrite: boolean) {
    for (const imported of pendingAccounts) {
      const exists = accounts.some((a) => a.email === imported.email);
      if (exists) {
        if (overwrite) await updateAccount(imported);
      } else {
        await addAccount(imported);
      }
    }
    setConflictModalOpen(false);
    setPendingAccounts([]);
    addToast(t("settings.data.importSuccess"), "success");
  }

  function handleClearData() {
    setShowClearModal(false);
    localStorage.clear();
    indexedDB.deleteDatabase("asspp-accounts");
    addToast(t("settings.data.cleared"), "success");
    setTimeout(() => {
      window.location.href = "/";
    }, 1000);
  }

  return (
    <PageContainer title={t("settings.title")}>
      <div className="min-w-0 space-y-6">
        <section className={cardClass}>
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            {t("settings.language.title")}
          </h2>
          <label htmlFor="language" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t("settings.language.label")}
          </label>
          <select
            id="language"
            value={i18n.resolvedLanguage || "en-US"}
            onChange={async (e) => {
              await i18n.changeLanguage(e.target.value);
              addToast(t("settings.language.changed"), "success");
            }}
            className={fieldClass}
          >
            <option value="en-US">English (US)</option>
            <option value="zh-CN">简体中文</option>
            <option value="zh-TW">繁體中文</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="ru">Русский</option>
          </select>
        </section>

        <section className={cardClass}>
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            {t("settings.server.title")}
          </h2>
          {serverInfo ? (
            <div className="min-w-0 space-y-6">
              <dl className="min-w-0 divide-y divide-gray-100 dark:divide-gray-800">
                {serverInfo.uptime != null && (
                  <SettingsInfoRow label={t("settings.server.uptime")}>
                    {formatUptime(serverInfo.uptime)}
                  </SettingsInfoRow>
                )}
              </dl>
              <div className="min-w-0">
                <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
                  {t("settings.server.configuration")}
                </h3>
                <dl className="min-w-0 divide-y divide-gray-100 border-y border-gray-100 dark:divide-gray-800 dark:border-gray-800">
                  <SettingsInfoRow label="PORT" mono>{serverInfo.port}</SettingsInfoRow>
                  <SettingsInfoRow label="DATA_DIR" mono valueTitle={serverInfo.dataDir}>{serverInfo.dataDir}</SettingsInfoRow>
                  <SettingsInfoRow label="PUBLIC_BASE_URL" mono valueTitle={serverInfo.publicBaseUrl || undefined}>
                    {serverInfo.publicBaseUrl || <span className="italic text-gray-400 dark:text-gray-500">{t("settings.server.notSet")}</span>}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT" mono>
                    {serverInfo.disableHttpsRedirect ? t("settings.server.enabled") : t("settings.server.disabled")}
                  </SettingsInfoRow>
                  <SettingsInfoRow label="AUTO_CLEANUP_DAYS" mono>{serverInfo.autoCleanupDays || t("settings.server.disabled")}</SettingsInfoRow>
                  <SettingsInfoRow label="AUTO_CLEANUP_MAX_MB" mono>{serverInfo.autoCleanupMaxMB || t("settings.server.disabled")}</SettingsInfoRow>
                  <SettingsInfoRow label="MAX_DOWNLOAD_MB" mono>{serverInfo.maxDownloadMB || t("settings.server.disabled")}</SettingsInfoRow>
                  <SettingsInfoRow label="DOWNLOAD_THREADS" mono>{serverInfo.downloadThreads ?? 8}</SettingsInfoRow>
                </dl>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t("settings.server.offline")}</p>
          )}
        </section>

        <section className={cardClass}>
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            {t("settings.data.title")}
          </h2>
          <p className="mb-4 max-w-full break-words text-sm leading-relaxed text-gray-600 dark:text-gray-400">
            {t("settings.data.description")}
          </p>
          <div className="mb-6 grid w-full min-w-0 grid-cols-2 gap-3 sm:max-w-sm">
            <button onClick={() => setExportModalOpen(true)} className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-full bg-blue-50 px-3 py-2 text-center text-sm font-semibold text-blue-600 transition-colors hover:bg-blue-100 sm:px-4 dark:bg-blue-950/60 dark:text-blue-400 dark:hover:bg-blue-950">
              {t("settings.data.exportBtn")}
            </button>
            <button onClick={() => fileInputRef.current?.click()} className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-full bg-green-50 px-3 py-2 text-center text-sm font-semibold text-green-700 transition-colors hover:bg-green-100 sm:px-4 dark:bg-green-950/60 dark:text-green-400 dark:hover:bg-green-950">
              {t("settings.data.importBtn")}
            </button>
            <input type="file" ref={fileInputRef} className="hidden" accept=".enc" onChange={handleFileSelect} />
          </div>
          <button onClick={() => setShowClearModal(true)} className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-full bg-red-50 px-4 py-2 text-center text-sm font-semibold text-red-600 transition-colors hover:bg-red-100 sm:w-auto dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/70">
            {t("settings.data.button")}
          </button>
        </section>

        <section className={cardClass}>
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            {t("settings.about.title")}
          </h2>
          <p className="max-w-full break-words text-sm leading-relaxed text-gray-600 dark:text-gray-400">
            {t("settings.about.description")}
          </p>
          {serverInfo && (
            <dl className="mt-3 min-w-0 divide-y divide-gray-100 dark:divide-gray-800">
              {serverInfo.buildCommit && serverInfo.buildCommit !== "unknown" && (
                <SettingsInfoRow label={t("settings.about.buildCommit")} mono compact valueTitle={serverInfo.buildCommit}>{serverInfo.buildCommit}</SettingsInfoRow>
              )}
              {serverInfo.buildDate && serverInfo.buildDate !== "unknown" && (
                <SettingsInfoRow label={t("settings.about.buildDate")} compact valueTitle={serverInfo.buildDate}>{new Date(serverInfo.buildDate).toLocaleString()}</SettingsInfoRow>
              )}
            </dl>
          )}
        </section>
      </div>

      <Modal open={exportModalOpen} onClose={() => setExportModalOpen(false)} title={t("settings.data.exportBtn")}>
        <div className="min-w-0 space-y-4">
          <div className="min-w-0">
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t("settings.data.passwordPrompt")}</label>
            <input type="password" value={exportPassword} onChange={(e) => setExportPassword(e.target.value)} className={modalFieldClass} />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t("settings.data.passwordConfirm")}</label>
            <input type="password" value={exportConfirmPassword} onChange={(e) => setExportConfirmPassword(e.target.value)} className={modalFieldClass} />
          </div>
        </div>
        <div className="mt-6 flex min-w-0 flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
          <button onClick={() => setExportModalOpen(false)} className="min-h-11 min-w-0 whitespace-normal break-words rounded-full bg-gray-100 px-5 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200 sm:w-auto dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">{t("settings.data.cancel")}</button>
          <button onClick={handleExport} disabled={!exportPassword || !exportConfirmPassword} className="min-h-11 min-w-0 whitespace-normal break-words rounded-full bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">{t("settings.data.confirmBtn")}</button>
        </div>
      </Modal>

      <Modal open={importModalOpen} onClose={() => setImportModalOpen(false)} title={t("settings.data.importBtn")}>
        <div className="min-w-0 space-y-4">
          <div className="min-w-0">
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t("settings.data.passwordPrompt")}</label>
            <input type="password" value={importPassword} onChange={(e) => setImportPassword(e.target.value)} className={modalFieldClass} />
          </div>
        </div>
        <div className="mt-6 flex min-w-0 flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
          <button onClick={() => setImportModalOpen(false)} className="min-h-11 min-w-0 whitespace-normal break-words rounded-full bg-gray-100 px-5 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200 sm:w-auto dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">{t("settings.data.cancel")}</button>
          <button onClick={handleImport} disabled={!importPassword} className="min-h-11 min-w-0 whitespace-normal break-words rounded-full bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">{t("settings.data.confirmBtn")}</button>
        </div>
      </Modal>

      <Modal open={conflictModalOpen} onClose={() => setConflictModalOpen(false)} title={t("settings.data.conflictTitle")}>
        <p className="mb-6 min-w-0 break-words text-sm leading-6 text-gray-700 dark:text-gray-300">
          {t("settings.data.conflictDesc", { conflict: conflictStats.conflict, new: conflictStats.new })}
        </p>
        <div className="flex min-w-0 flex-col gap-3">
          <button onClick={() => handleResolveConflict(true)} className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-full bg-red-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700">{t("settings.data.conflictOverwrite")}</button>
          <button onClick={() => handleResolveConflict(false)} className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-full bg-gray-100 px-5 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">{t("settings.data.conflictSkip")}</button>
          <button onClick={() => setConflictModalOpen(false)} className="mt-2 min-h-11 w-full min-w-0 whitespace-normal break-words rounded-full bg-gray-100 px-5 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">{t("settings.data.cancel")}</button>
        </div>
      </Modal>

      <ConfirmModal
        open={showClearModal}
        title={t("settings.data.button")}
        message={t("settings.data.confirm")}
        confirmText={t("settings.data.confirmBtn")}
        danger
        onConfirm={handleClearData}
        onCancel={() => setShowClearModal(false)}
      />
    </PageContainer>
  );
}

function SettingsInfoRow({ label, children, mono = false, compact = false, valueTitle }: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  compact?: boolean;
  valueTitle?: string;
}) {
  const size = compact ? "text-xs" : "text-sm";
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] sm:items-start sm:gap-6">
      <dt className={`${size} min-w-0 break-all font-medium text-gray-500 dark:text-gray-400`}>{label}</dt>
      <dd title={valueTitle} className={`${size} min-w-0 max-w-full whitespace-pre-wrap break-all text-gray-900 sm:text-right dark:text-gray-200 ${mono ? "font-mono" : ""}`}>{children}</dd>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}
