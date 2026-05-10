interface Props {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_MAP = {
  xs: 'w-3 h-3 border',
  sm: 'w-4 h-4 border-2',
  md: 'w-5 h-5 border-2',
  lg: 'w-6 h-6 border-2',
} as const;

export function Spinner({ size = 'md', className = '' }: Props) {
  return (
    <span
      className={`inline-block rounded-full border-ctp-subtext0 border-t-transparent animate-spin flex-shrink-0 ${SIZE_MAP[size]} ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}
