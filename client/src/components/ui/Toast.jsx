import clsx from 'clsx';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

export function Toast({
  message,
  variant = 'info',
  onClose,
  className = '',
}) {
  if (!message) return null;

  const icons = {
    success: CheckCircle2,
    warning: AlertTriangle,
    danger: AlertCircle,
    info: Info,
  };

  const colors = {
    success: 'text-[#3DD68C] border-[rgba(61,214,140,0.3)]',
    warning: 'text-[#F5B544] border-[rgba(245,181,68,0.3)]',
    danger: 'text-[#F2605C] border-[rgba(242,96,92,0.3)]',
    info: 'text-[#5B8DEF] border-[rgba(91,141,239,0.3)]',
  };

  const Icon = icons[variant] || Info;

  return (
    <div
      role="status"
      className={clsx(
        'fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 bg-[#161A21] border rounded-[6px] shadow-xl text-xs text-[#E6E8EC] max-w-md animate-fade-in',
        colors[variant] || colors.info,
        className
      )}
    >
      <Icon size={16} strokeWidth={1.75} className="shrink-0 text-current" />
      <span className="flex-1 leading-normal">{message}</span>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="text-[#667085] hover:text-[#E6E8EC] p-0.5 rounded transition-colors shrink-0"
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

export default Toast;

