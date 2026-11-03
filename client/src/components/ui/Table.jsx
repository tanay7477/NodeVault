import clsx from 'clsx';

export function Table({ children, className = '', ...props }) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={clsx('w-full border-collapse text-[13px] text-left', className)}
        {...props}
      >
        {children}
      </table>
    </div>
  );
}

export function TableHeader({ children, className = '', ...props }) {
  return (
    <thead
      className={clsx('bg-[#161A21] sticky top-0 z-10 border-b border-[#1F2530]', className)}
      {...props}
    >
      {children}
    </thead>
  );
}

export function TableBody({ children, className = '', ...props }) {
  return (
    <tbody className={clsx('divide-y divide-[#1F2530]', className)} {...props}>
      {children}
    </tbody>
  );
}

export function TableRow({ children, className = '', onClick, ...props }) {
  return (
    <tr
      onClick={onClick}
      className={clsx(
        'h-11 transition-colors duration-150 hover:bg-[#161A21]',
        onClick && 'cursor-pointer',
        className
      )}
      {...props}
    >
      {children}
    </tr>
  );
}

export function TableHead({ children, className = '', ...props }) {
  return (
    <th
      className={clsx(
        'h-10 px-4 text-xs font-medium text-[#667085] tracking-tight uppercase whitespace-nowrap select-none',
        className
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function TableCell({ children, className = '', mono = false, ...props }) {
  return (
    <td
      className={clsx(
        'px-4 text-[#E6E8EC] whitespace-nowrap align-middle',
        mono && 'font-mono text-xs text-[#98A1B0]',
        className
      )}
      {...props}
    >
      {children}
    </td>
  );
}

export default Table;

