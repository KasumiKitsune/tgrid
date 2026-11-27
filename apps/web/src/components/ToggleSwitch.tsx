import React, { useState } from 'react';

export interface ToggleSwitchProps {
  label: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  compact?: boolean;
  className?: string;
  ariaLabel?: string;
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  label,
  checked,
  onChange,
  disabled = false,
  title,
  compact = false,
  className,
  ariaLabel
}) => {
  const [pressed, setPressed] = useState(false);

  const rootClass = [
    'tg-switch',
    compact ? 'is-compact' : '',
    disabled ? 'is-disabled' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <label className={rootClass} title={title}>
      <span className="tg-switch-label">{label}</span>
      <span className="tg-switch-ctrl">
        <input
          type="checkbox"
          role="switch"
          className={`tg-switch-in${pressed ? ' is-pressed' : ''}`}
          checked={checked}
          aria-checked={checked}
          aria-label={ariaLabel}
          disabled={disabled}
          onChange={(e) => {
            if (!disabled) onChange(e.target.checked);
          }}
          onKeyDown={(e) => {
            if ((e.code === 'Space' || e.key === ' ') && !disabled) {
              setPressed(true);
            }
          }}
          onKeyUp={(e) => {
            if (e.code === 'Space' || e.key === ' ') {
              setPressed(false);
            }
          }}
          onBlur={() => {
            if (pressed) setPressed(false);
          }}
        />
        <span className="tg-switch-track" aria-hidden="true">
          <span className="tg-switch-mark-i" />
          <span className="tg-switch-mark-o" />
          <span className="tg-switch-thumb" />
        </span>
      </span>
    </label>
  );
};
