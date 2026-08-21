import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  /** 可选的底部操作区（如引导链接） */
  action?: ReactNode;
}

/**
 * 统一的空状态容器：大圆角卡片 + 居中图标 + 标题/描述 + 可选操作。
 * 遵循设计规范：不添加 transition-colors，避免暗色模式加载闪烁。
 * 列表页（搜索、下载、新建下载）空态必须复用此组件。
 */
export default function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="my-4 flex flex-col items-center justify-center rounded-3xl bg-white px-6 py-16 text-center shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 dark:bg-blue-950">
        {icon}
      </div>
      <h3 className="mb-2 text-center text-lg font-semibold text-gray-900 dark:text-white">
        {title}
      </h3>
      {description && (
        <p className="mb-6 max-w-sm break-words text-center text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          {description}
        </p>
      )}
      {action}
    </div>
  );
}
