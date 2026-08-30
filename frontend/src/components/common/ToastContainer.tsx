import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore, type Toast, type ToastType } from "../../store/toast";

const iconBg: Record<ToastType, string> = {
  success:
    "bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400",
  error: "bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400",
  info: "bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400",
};

const titleColor: Record<ToastType, string> = {
  success: "text-green-700 dark:text-green-300",
  error: "text-red-700 dark:text-red-300",
  info: "text-blue-700 dark:text-blue-300",
};

const icons: Record<ToastType, ReactNode> = {
  success: (
    <svg
      aria-hidden="true"
      focusable="false"
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  ),
  error: (
    <svg
      aria-hidden="true"
      focusable="false"
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  ),
  info: (
    <svg
      aria-hidden="true"
      focusable="false"
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  ),
};

// 退出动画时长（与 CSS animate-toast-out 保持一致）
const EXIT_ANIMATION_MS = 300;

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();
  const { t } = useTranslation();

  // 正在播放退出动画的 toast：store 已移除它们，但暂留渲染直至动画结束
  const [leaving, setLeaving] = useState<Record<string, Toast>>({});
  const [copiedId, setCopiedId] = useState<string>();
  const prevToastsRef = useRef<Toast[]>([]);

  useEffect(() => {
    const currentIds = new Set(toasts.map((toast) => toast.id));
    const newlyGone: Toast[] = [];
    for (const prevToast of prevToastsRef.current) {
      if (!currentIds.has(prevToast.id) && !leaving[prevToast.id]) {
        newlyGone.push(prevToast);
      }
    }

    if (newlyGone.length > 0) {
      setLeaving((prev) => {
        const next = { ...prev };
        for (const toast of newlyGone) next[toast.id] = toast;
        return next;
      });
      for (const toast of newlyGone) {
        setTimeout(() => {
          setLeaving((prev) => {
            if (!prev[toast.id]) return prev;
            const next = { ...prev };
            delete next[toast.id];
            return next;
          });
        }, EXIT_ANIMATION_MS);
      }
    }

    prevToastsRef.current = toasts;
  }, [toasts, leaving]);

  async function copyToast(toast: Toast) {
    const text = toast.title ? `${toast.title}\n${toast.message}` : toast.message;
    let copied = false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      // Fall through to the selection-based fallback for older iOS/PWA cases.
    }

    if (!copied) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      copied = document.execCommand("copy");
      textarea.remove();
    }

    if (copied) {
      setCopiedId(toast.id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === toast.id ? undefined : current));
      }, 1500);
    }
  }

  const allToasts = [
    ...toasts.map((toast) => ({ toast, leaving: false })),
    ...Object.values(leaving).map((toast) => ({ toast, leaving: true })),
  ];

  return (
    <>
      <style>
        {`
          @keyframes toast-slide-in {
            from { transform: translateX(120%); opacity: 0; }
            to   { transform: translateX(0);    opacity: 1; }
          }
          .animate-toast-in {
            animation: toast-slide-in 0.36s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          }
          @keyframes toast-slide-out {
            from { transform: translateX(0); opacity: 1; }
            to   { transform: translateX(120%); opacity: 0; }
          }
          .animate-toast-out {
            animation: toast-slide-out 0.3s cubic-bezier(0.4, 0, 1, 1) forwards;
          }
          @media (prefers-reduced-motion: reduce) {
            .animate-toast-in, .animate-toast-out { animation: none; }
          }
        `}
      </style>

      <div
        className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+4.625rem)] left-4 right-4 top-[calc(env(safe-area-inset-top)+4rem)] z-[100] flex flex-col items-end gap-3 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:none] md:bottom-4 md:left-auto md:top-4 [&::-webkit-scrollbar]:hidden"
        role="region"
        aria-label={t("toast.regionLabel")}
      >
        {allToasts.map(({ toast, leaving: isLeaving }) => (
          <div
            key={toast.id}
            role={toast.type === "error" ? "alert" : "status"}
            aria-live={toast.type === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            className={`${isLeaving ? "animate-toast-out" : "animate-toast-in"} pointer-events-auto flex w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] shrink-0 items-start gap-3 rounded-[20px] border border-gray-200/80 bg-white/95 p-3 shadow-[0_18px_50px_-18px_rgba(15,23,42,0.4)] backdrop-blur-2xl sm:w-auto sm:min-w-[320px] sm:max-w-md dark:border-white/10 dark:bg-gray-900/95 dark:shadow-black/60`}
          >
            <div
              className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] ${iconBg[toast.type]}`}
            >
              {icons[toast.type]}
            </div>

            <div className="min-w-0 flex-1 py-0.5">
              {toast.title && (
                <h4
                  className={`mb-0.5 text-sm font-semibold leading-5 ${titleColor[toast.type]}`}
                >
                  {toast.title}
                </h4>
              )}
              <p className="whitespace-pre-line break-words text-sm leading-5 text-gray-700 dark:text-gray-200">
                {toast.message}
              </p>
            </div>

            <div className="-mr-1 -mt-1 flex shrink-0 items-center gap-1">
              <button
                onClick={() => void copyToast(toast)}
                className="flex h-8 min-w-8 items-center justify-center gap-1 rounded-full px-2 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                aria-label={t("toast.copy")}
                title={t("toast.copy")}
              >
                <svg
                  aria-hidden="true"
                  focusable="false"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7V5a2 2 0 012-2h7a2 2 0 012 2v7a2 2 0 01-2 2h-2M7 9h7a2 2 0 012 2v7a2 2 0 01-2 2H7a2 2 0 01-2-2v-7a2 2 0 012-2z"
                  />
                </svg>
                {copiedId === toast.id && <span>{t("toast.copied")}</span>}
              </button>

              <button
                onClick={() => {
                  if (isLeaving) {
                    setLeaving((prev) => {
                      const next = { ...prev };
                      delete next[toast.id];
                      return next;
                    });
                  } else {
                    removeToast(toast.id);
                  }
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                aria-label={t("toast.close")}
              >
                <svg
                  aria-hidden="true"
                  focusable="false"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
