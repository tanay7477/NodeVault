import { useState } from 'react';
import clsx from 'clsx';

export function Tooltip({
  content,
  children,
  position = 'top',
  delay = 200,
  className = '',
}) {
  const [visible, setVisible] = useState(false);
  const [timeoutId, setTimeoutId] = useState(null);

  const show = () => {
    const id = setTimeout(() => setVisible(true), delay);
    setTimeoutId(id);
  };

  const hide = () => {
    clearTimeout(timeoutId);
    setVisible(false);
  };

  const positions = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
  };

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {visible && content && (
        <div
          role="tooltip"
          className={clsx(
            'absolute z-50 px-2.5 py-1 text-[11px] font-medium text-[#E6E8EC] bg-[#161A21] border border-[#2A3140] rounded-[4px] shadow-lg whitespace-nowrap pointer-events-none animate-fade-in',
            positions[position] || positions.top,
            className
          )}
        >
          {content}
        </div>
      )}
    </div>
  );
}

export default Tooltip;

