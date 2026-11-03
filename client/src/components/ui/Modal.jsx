import { useEffect } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  maxWidth = 'max-w-md',
  className = '',
}) {
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose?.();
    }
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/65 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        className={clsx(
          'relative w-full bg-[#11141A] border border-[#2A3140] rounded-[8px] shadow-2xl overflow-hidden animate-fade-in z-10 flex flex-col',
          maxWidth,
          className
        )}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#1F2530] flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#E6E8EC] tracking-tight">{title}</h2>
            {description && (
              <p className="text-xs text-[#98A1B0] mt-0.5">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-[4px] text-[#667085] hover:text-[#E6E8EC] hover:bg-[#161A21] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8DEF]"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 text-xs text-[#E6E8EC] overflow-y-auto max-h-[75vh]">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="px-5 py-3.5 border-t border-[#1F2530] bg-[#161A21] flex items-center justify-end gap-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export default Modal;

