import type { ReactNode } from 'react';

export type BadgeVariant =
  | 'ok'
  | 'warn'
  | 'error'
  | 'info'
  | 'tool'
  | 'color'
  | 'insert'
  | 'neutral';

export function Badge({
  variant = 'neutral',
  children,
  title,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge ${variant}`} title={title}>
      {children}
    </span>
  );
}
