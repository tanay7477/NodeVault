import clsx from 'clsx';

export function Skeleton({ className = '', ...props }) {
  return (
    <div
      className={clsx(
        'bg-[#161A21] animate-pulse rounded-[4px]',
        className
      )}
      {...props}
    />
  );
}

export function SkeletonText({ lines = 3, className = '' }) {
  return (
    <div className={clsx('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={clsx('h-4', i === lines - 1 ? 'w-3/4' : 'w-full')}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className = '' }) {
  return (
    <div className={clsx('bg-[#11141A] border border-[#1F2530] rounded-[8px] p-4 space-y-3', className)}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

export default Skeleton;

