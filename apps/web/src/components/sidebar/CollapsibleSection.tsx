import React, { useState } from 'react';
import { TGridIcon } from '../Icons';

const SECTIONS_STORAGE_KEY = 'tgrid_sidebar_sections_v1';

function readSectionStates(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(SECTIONS_STORAGE_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return raw as Record<string, boolean>;
    }
  } catch {
    // ignore storage errors
  }
  return {};
}

function persistSectionState(id: string, open: boolean): void {
  try {
    const next = readSectionStates();
    next[id] = open;
    localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
}

export interface CollapsibleSectionProps {
  id: string;
  title: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  id,
  title,
  badge,
  defaultOpen = true,
  children
}) => {
  const [open, setOpen] = useState<boolean>(() => {
    const map = readSectionStates();
    return typeof map[id] === 'boolean' ? map[id] : defaultOpen;
  });

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      persistSectionState(id, next);
      return next;
    });
  };

  return (
    <section className={`sb-acc ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="sb-acc-head"
        aria-expanded={open}
        onClick={handleToggle}
      >
        <span className="sb-acc-left">
          <TGridIcon name="section-chevron" size={12} className="sb-acc-chev" />
          <span className="sb-acc-title">{title}</span>
        </span>
        {badge !== undefined && badge !== null && badge !== '' && (
          <span className="sb-acc-badge">{badge}</span>
        )}
      </button>
      <div className="sb-acc-collapse">
        <div className="sb-acc-collapse-inner">
          <div className="sb-acc-body">{children}</div>
        </div>
      </div>
    </section>
  );
};
