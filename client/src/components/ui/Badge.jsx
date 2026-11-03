import clsx from 'clsx';

export function Badge({
  children,
  variant = 'neutral',
  dot = true,
  className = '',
  ...props
}) {
  const variants = {
    success: 'bg-[rgba(61,214,140,0.1)] text-[#3DD68C] border-[rgba(61,214,140,0.25)]',
    warning: 'bg-[rgba(245,181,68,0.1)] text-[#F5B544] border-[rgba(245,181,68,0.25)]',
    danger: 'bg-[rgba(242,96,92,0.1)] text-[#F2605C] border-[rgba(242,96,92,0.25)]',
    neutral: 'bg-[#161A21] text-[#98A1B0] border-[#1F2530]',
    info: 'bg-[rgba(91,141,239,0.1)] text-[#5B8DEF] border-[rgba(91,141,239,0.25)]',
  };

  const dotColors = {
    success: 'bg-[#3DD68C]',
    warning: 'bg-[#F5B544]',
    danger: 'bg-[#F2605C]',
    neutral: 'bg-[#667085]',
    info: 'bg-[#5B8DEF]',
  };

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium border rounded-[4px] select-none',
        variants[variant] || variants.neutral,
        className
      )}
      {...props}
    >
      {dot && (
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0',
            dotColors[variant] || dotColors.neutral
          )}
        />
      )}
      <span>{children}</span>
    </span>
  );
}

export default Badge;

