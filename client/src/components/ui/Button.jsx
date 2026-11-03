import { forwardRef } from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

export const Button = forwardRef(function Button(
  {
    children,
    variant = 'secondary',
    size = 'md',
    loading = false,
    disabled = false,
    icon: Icon,
    iconPosition = 'left',
    className = '',
    type = 'button',
    ...props
  },
  ref
) {
  const baseClasses =
    'inline-flex items-center justify-center font-medium rounded-[6px] transition-colors duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8DEF] focus-visible:ring-offset-1 focus-visible:ring-offset-[#0B0D10]';

  const variants = {
    primary: 'bg-[#5B8DEF] hover:bg-[#4A7CDA] text-white border border-[#5B8DEF]',
    secondary: 'bg-[#161A21] hover:bg-[#1F2530] text-[#E6E8EC] border border-[#1F2530] hover:border-[#2A3140]',
    ghost: 'bg-transparent hover:bg-[#161A21] text-[#98A1B0] hover:text-[#E6E8EC] border border-transparent',
    danger: 'bg-transparent hover:bg-[rgba(242,96,92,0.12)] text-[#F2605C] border border-[rgba(242,96,92,0.35)] hover:border-[#F2605C]',
  };

  const sizes = {
    sm: 'px-2.5 py-1 text-xs gap-1.5 h-7',
    md: 'px-3.5 py-1.5 text-[13px] gap-2 h-8',
    lg: 'px-4 py-2 text-sm gap-2 h-9',
  };

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(baseClasses, variants[variant], sizes[size], className)}
      {...props}
    >
      {loading ? (
        <Loader2 className="animate-spin text-current" size={14} strokeWidth={1.75} />
      ) : Icon && iconPosition === 'left' ? (
        <Icon size={15} strokeWidth={1.75} className="text-current shrink-0" />
      ) : null}

      <span>{children}</span>

      {!loading && Icon && iconPosition === 'right' ? (
        <Icon size={15} strokeWidth={1.75} className="text-current shrink-0" />
      ) : null}
    </button>
  );
});

export default Button;

