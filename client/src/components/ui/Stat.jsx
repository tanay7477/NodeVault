import clsx from 'clsx';

export function Stat({
  label,
  value,
  sub,
  delta,
  deltaType = 'neutral',
  icon: Icon,
  className = '',
}) {
  const deltaColors = {
    positive: 'text-[#3DD68C]',
    negative: 'text-[#F2605C]',
    warning: 'text-[#F5B544]',
    neutral: 'text-[#98A1B0]',
  };

  return (
    <div
      className={clsx(
        'bg-[#11141A] border border-[#1F2530] rounded-[8px] p-4 flex flex-col justify-between gap-2.5',
        className
      )}
    >
      <div className="flex items-center justify-between text-xs text-[#98A1B0] font-medium">
        <span>{label}</span>
        {Icon && <Icon size={16} strokeWidth={1.75} className="text-[#667085]" />}
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-[#E6E8EC] tabular-nums tracking-tight">
          {value}
        </span>
        {delta && (
          <span
            className={clsx(
              'text-xs font-medium tabular-nums',
              deltaColors[deltaType] || deltaColors.neutral
            )}
          >
            {delta}
          </span>
        )}
      </div>

      {sub && <p className="text-xs text-[#667085] leading-normal">{sub}</p>}
    </div>
  );
}

export default Stat;

