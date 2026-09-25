import { useId, useRef, type ReactNode } from 'react';
import { handleTablistKeyDown } from '../components/tabs';
import { cx } from '../utils';

export interface FeedTabDef {
  id: string;
  label: string;
}

/**
 * Feed switcher: a tablist whose tabs all control one shared panel (the feed). The panel is labelled by the
 * active tab, and content inside it is announced through its own live regions.
 */
export function FeedTabs({
  tabs,
  value,
  onChange,
  label,
  children,
  className,
}: {
  tabs: FeedTabDef[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const base = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const panelId = `${base}-panel`;
  return (
    <div className={cx('yl-feedtabs', className)}>
      <div className="yl-feedtabs__bar">
        <div
          ref={listRef}
          role="tablist"
          aria-label={label}
          className="yl-tablist yl-tablist--scroll"
          onKeyDown={(e) => handleTablistKeyDown(e, listRef.current, onChange)}
        >
          {tabs.map((t) => {
            const selected = t.id === value;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${base}-tab-${t.id}`}
                data-value={t.id}
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                className={cx('yl-tab', selected && 'is-selected')}
                onClick={() => onChange(t.id)}
              >
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${base}-tab-${value}`}
        tabIndex={-1}
        className="yl-feedtabs__panel"
      >
        {children}
      </div>
    </div>
  );
}
