import type { ReactNode } from 'react';

interface Props {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}

/** Titled container used for every board panel. */
export function Panel({ title, actions, children, flush }: Props) {
  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">{title}</span>
        {actions}
      </header>
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}
