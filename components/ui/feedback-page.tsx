import type { ReactNode } from "react";
import { Brand } from "@/components/brand/Brand";

export function FeedbackPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="feedback-page">
      <Brand />
      <div>
        <p className="eyebrow">AnaAI / Your workspace</p>
        <h1>{title}</h1>
        <p>{description}</p>
        <div className="feedback-actions">{children}</div>
      </div>
    </main>
  );
}
