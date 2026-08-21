import Spinner from "./Spinner";

/**
 * 页面级加载态：居中 Spinner + 可选文案。
 * 替换各处散落的纯文本「加载中...」，保持加载反馈一致。
 */
export default function LoadingState({
  label,
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 py-12 text-gray-500 dark:text-gray-400 ${className}`}
      role="status"
      aria-live="polite"
    >
      <Spinner />
      {label && <p className="text-sm">{label}</p>}
    </div>
  );
}
