import Link from "next/link";
import { FeedbackPage } from "@/components/ui/feedback-page";

export default function NotFound() {
  return (
    <FeedbackPage
      title="This page isn’t here."
      description="The address may have changed. You can return to AnaAI or open your workspace."
    >
      <Link className="marketing-button primary" href="/dashboard">
        Open workspace
      </Link>
      <Link className="marketing-button secondary" href="/">
        AnaAI home
      </Link>
    </FeedbackPage>
  );
}
