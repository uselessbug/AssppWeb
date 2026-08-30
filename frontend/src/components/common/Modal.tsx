import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

interface ScrollLockSnapshot {
  body: HTMLElement;
  root: HTMLElement;
  bodyOverflow: string;
  bodyOverscrollBehavior: string;
  bodyPaddingRight: string;
  rootOverflow: string;
  rootOverscrollBehavior: string;
}

let scrollLockCount = 0;
let scrollLockSnapshot: ScrollLockSnapshot | null = null;

function lockBackgroundScroll() {
  if (scrollLockCount === 0) {
    const body = document.body;
    const root = document.documentElement;
    const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);

    scrollLockSnapshot = {
      body,
      root,
      bodyOverflow: body.style.overflow,
      bodyOverscrollBehavior: body.style.overscrollBehavior,
      bodyPaddingRight: body.style.paddingRight,
      rootOverflow: root.style.overflow,
      rootOverscrollBehavior: root.style.overscrollBehavior,
    };

    if (scrollbarWidth > 0) {
      const currentPadding = Number.parseFloat(
        window.getComputedStyle(body).paddingRight,
      );
      body.style.paddingRight = `${(Number.isFinite(currentPadding) ? currentPadding : 0) + scrollbarWidth}px`;
    }

    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
  }

  scrollLockCount += 1;

  return () => {
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount !== 0 || !scrollLockSnapshot) return;

    const snapshot = scrollLockSnapshot;
    snapshot.body.style.overflow = snapshot.bodyOverflow;
    snapshot.body.style.overscrollBehavior = snapshot.bodyOverscrollBehavior;
    snapshot.body.style.paddingRight = snapshot.bodyPaddingRight;
    snapshot.root.style.overflow = snapshot.rootOverflow;
    snapshot.root.style.overscrollBehavior = snapshot.rootOverscrollBehavior;
    scrollLockSnapshot = null;
  };
}

export default function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const unlockScroll = lockBackgroundScroll();
    const dialog = dialogRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      unlockScroll();
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto overscroll-contain bg-gray-950/45 backdrop-blur-sm"
      style={{
        paddingTop: "calc(1rem + env(safe-area-inset-top))",
        paddingRight: "calc(1rem + env(safe-area-inset-right))",
        paddingBottom: "calc(1rem + env(safe-area-inset-bottom))",
        paddingLeft: "calc(1rem + env(safe-area-inset-left))",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-sm overflow-y-auto overscroll-contain rounded-[28px] border border-white/70 bg-white/95 p-6 text-gray-900 shadow-[0_24px_70px_-20px_rgba(15,23,42,0.45)] outline-none backdrop-blur-2xl dark:border-white/10 dark:bg-gray-900/95 dark:text-white dark:shadow-black/60"
        style={{
          maxHeight:
            "calc(100dvh - 2rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
        }}
      >
        <h3 id={titleId} className="mb-4 text-lg font-semibold tracking-tight">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}
