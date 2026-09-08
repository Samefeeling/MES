import type { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary';
  icon?: boolean;
}

export function Button({
  variant = 'default',
  icon = false,
  className = '',
  ...rest
}: ButtonProps) {
  const cls = [
    'btn',
    variant === 'primary' ? 'primary' : '',
    icon ? 'icon' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <button className={cls} {...rest} />;
}
