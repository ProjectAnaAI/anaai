"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FeedbackPage } from "@/components/ui/feedback-page";

// Next 16.3 uses retry() to re-fetch and render a failed segment.
export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <FeedbackPage
      title="We couldn’t open this page."
      description="Try opening it again. If an appointment action was in progress, check its status before repeating it."
    >
      <Button onClick={() => retry()}>Try again</Button>
      <Link className="marketing-button secondary" href="/dashboard">
        Open workspace
      </Link>
    </FeedbackPage>
  );
}
