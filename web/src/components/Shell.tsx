import { useEffect, useRef, useState } from 'react';
import type { Preset } from '../types';

const NAV = [
  { id: 'board', label: 'Board', glyph: '▦' },
  { id: 'markets', label: 'Markets', glyph: '☰' },
  { id: 'blotter', label: 'Blotter', glyph: '⇅' },
  { id: 'positions', label: 'Positions', glyph: '◱' },
  { id: 'history', label: 'History', glyph: '◷' },
];

interface SidebarProps {
  active: string;
  onSelect: (id: string) => void;
}

export function Sidebar({ active, onSelect }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
      <div className="brand">
        <span className="brand-mark" />
        {!collapsed && <span>PolyTerm</span>}
      </div>

      <nav className="nav">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={item.id === active ? 'nav-item active' : 'nav-item'}
            onClick={() => onSelect(item.id)}
            title={item.label}
          >
            <span className="glyph">{item.glyph}</span>
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button className="nav-item" onClick={() => setCollapsed((c) => !c)}>
          <span className="glyph">{collapsed ? '»' : '«'}</span>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

/**
 * Searchable, grouped multi-select. Closes on outside click and on Escape so
 * it behaves like a native menu.
 */
interface FacetProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}

export function FacetFilter({ label, options, selected, onChange }: FacetProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visible = options.filter((o) => o.toLowerCase().includes(query.toLowerCase()));
  const toggle = (option: string) =>
    onChange(selected.includes(option) ? selected.filter((s) => s !== option) : [...selected, option]);

  return (
    <div className="dropdown" ref={ref}>
      <button className="chip" onClick={() => setOpen((o) => !o)}>
        <span className="label">{label}</span>
        <span className="value">{selected.length ? `${selected.length} selected` : 'All'}</span>
        <span className="faint">▾</span>
      </button>

      {open && (
        <div className="menu">
          <div className="menu-search">
            <input
              autoFocus
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="menu-list">
            <div className="menu-group">Categories</div>
            {visible.map((option) => (
              <button className="menu-item" key={option} onClick={() => toggle(option)}>
                <input type="checkbox" readOnly checked={selected.includes(option)} />
                <span>{option}</span>
              </button>
            ))}
            {!visible.length && <div className="empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Saved filter sets, shown as the chip row above the board. */
interface PresetProps {
  presets: Preset[];
  activeId: string | null;
  onApply: (preset: Preset) => void;
  onSave: (name: string) => void;
  onRemove: (id: string) => void;
}

export function PresetMenu({ presets, activeId, onApply, onSave, onRemove }: PresetProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setName('');
    setOpen(false);
  };

  return (
    <div className="dropdown" ref={ref}>
      <button className="chip ghost" onClick={() => setOpen((o) => !o)}>+ Preset</button>
      {open && (
        <div className="menu">
          <div className="menu-search">
            <input
              placeholder="Name this view…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          </div>
          <div className="menu-list">
            {presets.length > 0 && <div className="menu-group">Saved</div>}
            {presets.map((preset) => (
              <div className="menu-item" key={preset.id}>
                <button
                  style={{ flex: 1, textAlign: 'left' }}
                  onClick={() => { onApply(preset); setOpen(false); }}
                >
                  <strong style={{ color: preset.id === activeId ? 'var(--accent)' : undefined }}>
                    {preset.name}
                  </strong>
                  <div className="faint" style={{ fontSize: 11 }}>
                    {preset.categories.join(', ') || 'All categories'}
                  </div>
                </button>
                <button className="faint" onClick={() => onRemove(preset.id)} title="Delete">✕</button>
              </div>
            ))}
            {!presets.length && <div className="empty">Name the current filters to save them</div>}
          </div>
        </div>
      )}
    </div>
  );
}
