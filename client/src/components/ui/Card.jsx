import clsx from 'clsx';

export function Card({ children, className = '', ...props }) {
  return (
    <div
      className={clsx(
        'bg-[#11141A] border border-[#1F2530] rounded-[8px] overflow-hidden',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className = '', ...props }) {
  return (
    <div
      className={clsx(
        'px-4 py-3.5 border-b border-[#1F2530] flex items-center justify-between gap-3',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, className = '', ...props }) {
  return (
    <h3
      className={clsx('text-sm font-semibold text-[#E6E8EC] tracking-tight', className)}
      {...props}
    >
      {children}
    </h3>
  );
}

export function CardDescription({ children, className = '', ...props }) {
  return (
    <p className={clsx('text-xs text-[#98A1B0] mt-0.5', className)} {...props}>
      {children}
    </p>
  );
}

export function CardContent({ children, className = '', ...props }) {
  return (
    <div className={clsx('p-4 text-[13px]', className)} {...props}>
      {children}
    </div>
  );
}

export function CardFooter({ children, className = '', ...props }) {
  return (
    <div
      className={clsx(
        'px-4 py-3 border-t border-[#1F2530] bg-[#161A21] flex items-center justify-between text-xs text-[#98A1B0]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export default Card;

