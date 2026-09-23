import Link from "next/link";
import { ArrowUpRight, BookOpen, CalendarDays, Phone } from "lucide-react";
import AppLayout from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/ui/page-header";
import { VoiceLine } from "@/components/brand/Brand";

export default function CallsPage() {
  return (
    <AppLayout>
      <div className="space-y-6" data-page="calls">
        <PageHeader
          eyebrow="AnaAI / Conversations"
          title="Calls"
          description="A place to review your receptionist’s work."
        />
        <section className="calls-unavailable">
          <div className="calls-intro">
            <span className="availability-label">
              Call history · Coming soon
            </span>
            <h2>
              Every conversation
              <br />
              deserves a clear follow-up.
            </h2>
            <p>
              Call history, transcripts, recordings, and call outcomes are not
              available in this workspace yet. No call activity is shown here.
            </p>
            <VoiceLine />
          </div>
          <div className="calls-next">
            <Phone size={24} />
            <h3>Keep your receptionist ready.</h3>
            <p>
              You can review the greeting, check business answers, and manage
              appointments now.
            </p>
            {[
              {
                href: "/ai",
                label: "Review receptionist settings",
                icon: Phone,
              },
              {
                href: "/knowledge",
                label: "Update business knowledge",
                icon: BookOpen,
              },
              {
                href: "/appointments",
                label: "Open your appointments",
                icon: CalendarDays,
              },
            ].map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href}>
                <Icon size={17} />
                <span>{label}</span>
                <ArrowUpRight size={16} />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </AppLayout>
  );
}
