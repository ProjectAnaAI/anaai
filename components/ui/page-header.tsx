import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="workspace-page-header">
      <div className="min-w-0">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="anaai-page-title">{title}</h1>
        <div className="anaai-page-description">{description}</div>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
