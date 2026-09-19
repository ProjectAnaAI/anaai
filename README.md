# AnaAI

AnaAI is a multi-tenant AI receptionist platform for service businesses. It combines business configuration, customer and appointment management, an AI voice receptionist, and operational analytics in a single web application.

The current implementation is focused on production-ready business onboarding, appointment operations, customer/service data, and Twilio-based voice receptionist workflows.

## Technology

- Next.js 16 / React 19 / TypeScript
- Supabase Auth + PostgreSQL + Row Level Security
- Twilio Voice
- OpenAI
- Vercel
- Tailwind CSS / shadcn UI

## Architecture

AnaAI is multi-tenant.

The core authorization flow is:

```text
authenticated user
→ business_members
→ active business selection
→ business-scoped query or mutation
→ RLS / server-side validation