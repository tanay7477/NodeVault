import clsx from 'clsx';

export function PageHeader({
  title,
  description,
  actions,
  badge,
  className = '',
}) {
  return (
    <div
      className={clsx(
        'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-[#1F2530]',
        className
      )}
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold text-[#E6E8EC] tracking-tight">{title}</h1>
          {badge}
        </div>
        {description && (
          <p className="text-sm text-[#98A1B0] leading-normal">{description}</p>
        )}
      </div>

      {actions && (
        <div className="flex items-center gap-2.5 shrink-0 self-start sm:self-center">
          {actions}
        </div>
      )}
    </div>
  );
}

export default PageHeader;

