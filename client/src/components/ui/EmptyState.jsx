import clsx from 'clsx';
import { Inbox } from 'lucide-react';

export function EmptyState({
  icon: Icon = Inbox,
  title = 'No records found',
  hint,
  action,
  className = '',
}) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center p-8 sm:p-12 text-center rounded-[8px] bg-[#11141A] border border-[#1F2530]',
        className
      )}
    >
      <div className="w-10 h-10 rounded-full bg-[#161A21] border border-[#1F2530] flex items-center justify-center text-[#667085] mb-3 shrink-0">
        <Icon size={18} strokeWidth={1.75} />
      </div>

      <h3 className="text-sm font-medium text-[#E6E8EC] mb-1">{title}</h3>

      {hint && (
        <p className="text-xs text-[#98A1B0] max-w-sm mb-4 leading-relaxed">
          {hint}
        </p>
      )}

      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export default EmptyState;

