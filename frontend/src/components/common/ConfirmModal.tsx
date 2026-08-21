import { useTranslation } from "react-i18next";
import Modal from "./Modal";
import Spinner from "./Spinner";

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除/清空）使用红色确认按钮 */
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 统一的确认对话框：替代浏览器原生 confirm()，
 * 保证暗色模式、移动端与键盘操作下的一致体验。
 */
export default function ConfirmModal({
  open,
  title,
  message,
  confirmText,
  cancelText,
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const { t } = useTranslation();

  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
        {message}
      </p>
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button
          onClick={onCancel}
          disabled={loading}
          className="min-h-11 rounded-full bg-gray-100 px-5 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          {cancelText ?? t("settings.data.cancel")}
        </button>
        <button
          onClick={onConfirm}
          disabled={loading}
          className={`flex min-h-11 items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${
            danger ? "bg-red-600" : "bg-blue-600"
          }`}
        >
          {loading && <Spinner />}
          {confirmText ?? t("settings.data.confirmBtn")}
        </button>
      </div>
    </Modal>
  );
}
