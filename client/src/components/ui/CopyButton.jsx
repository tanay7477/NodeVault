import { useState } from 'react';
import clsx from 'clsx';
import { Copy, Check } from 'lucide-react';

export function CopyButton({
  text,
  className = '',
  label = 'Copy',
  copiedLabel = 'Copied',
  showLabel = false,
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore clipboard error
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      className={clsx(
        'inline-flex items-center gap-1.5 p-1 rounded-[4px] text-[#98A1B0] hover:text-[#E6E8EC] hover:bg-[#161A21] border border-transparent hover:border-[#1F2530] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8DEF]',
        showLabel && 'px-2 py-1 text-xs',
        className
      )}
    >
      {copied ? (
        <Check size={14} strokeWidth={1.75} className="text-[#3DD68C] shrink-0" />
      ) : (
        <Copy size={14} strokeWidth={1.75} className="text-[#667085] shrink-0" />
      )}
      {showLabel && <span>{copied ? copiedLabel : label}</span>}
    </button>
  );
}

export default CopyButton;

