import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  PhoneForwarded,
} from "lucide-react";
import { Brand, VoiceLine } from "@/components/brand/Brand";
import { CallDemo } from "@/components/marketing/CallDemo";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { ProductDemo } from "@/components/marketing/ProductDemo";

const questions = [
  [
    "What does AnaAI do?",
    "AnaAI answers inbound business calls, helps callers with business questions, and handles supported appointment requests. Your workspace brings appointments, customers, services, and receptionist settings together.",
  ],
  [
    "Can AnaAI book, reschedule, and cancel?",
    "Yes. AnaAI can help callers book a service or manage an existing appointment. Availability depends on your business hours, timezone, service duration, and simultaneous appointment capacity. Changes require the appropriate appointment details and confirmation.",
  ],
  [
    "Can a caller speak to a person?",
    "AnaAI supports human handoff when it is configured for your business. A transfer request does not guarantee that a person will answer.",
  ],
  [
    "How does AnaAI know about my business?",
    "You provide your business profile, services, hours, and knowledge entries. Keep those details current so AnaAI has useful information to answer caller questions. There is no automatic website synchronization.",
  ],
  [
    "Can I review calls?",
    "This version does not yet expose call history or recordings in the workspace. You can review appointments and customer information, and use the receptionist’s text preview to check answers.",
  ],
  [
    "Who is AnaAI for?",
    "Salons, spas, barbers, beauty and wellness businesses, and other appointment businesses. Scheduling is based on the number of customers your business can serve at once, rather than individual staff calendars.",
  ],
];

export default function Home() {
  return (
    <div className="marketing">
      <MarketingNav />
      <main id="main-content">
        <section className="marketing-hero" id="product">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="green-dot" />
              AI receptionist for appointment businesses
            </p>
            <h1>
              Your hands are full.
              <br />
              <em>
                Your front desk
                <br className="desktop-break" /> doesn’t have to be.
              </em>
            </h1>
            <p className="hero-description">
              AnaAI answers calls, helps with questions, and takes care of
              appointments—so you can give the customer in front of you your
              full attention.
            </p>
            <div className="hero-actions">
              <Link className="marketing-button primary" href="/signup">
                Get started <ArrowUpRight size={18} />
              </Link>
              <a className="marketing-button secondary" href="#demo">
                See AnaAI in action <ArrowRight size={17} />
              </a>
            </div>
            <p className="hero-detail">
              Your services. Your hours. Your way of welcoming people.
            </p>
          </div>
          <CallDemo />
        </section>
        <div className="business-strip">
          <p>Made for the rhythm of your business</p>
          <span>Salons</span>
          <span>Spas</span>
          <span>Barbers</span>
          <span>Beauty & wellness</span>
        </div>
        <section className="marketing-section story-section" id="how-it-works">
          <div className="story-intro">
            <p className="eyebrow">One conversation. Less back-and-forth.</p>
            <h2>
              From “hello”
              <br />
              to “see you then.”
            </h2>
            <p>
              Good service starts before someone walks through your door. AnaAI
              helps the conversation move forward, with your business
              information at hand.
            </p>
            <VoiceLine />
          </div>
          <ol className="voice-journey">
            {[
              [
                "01",
                "Answer with a familiar welcome.",
                "Your greeting sets the tone. AnaAI picks up the conversation in your business’s name.",
              ],
              [
                "02",
                "Understand what matters.",
                "A question about hours, a new booking, or a change of plans. AnaAI uses the details you provide.",
              ],
              [
                "03",
                "Find room in your day.",
                "Business hours, service duration, and simultaneous capacity guide available appointment times.",
              ],
              [
                "04",
                "Confirm the next step.",
                "Book, reschedule, cancel, or try a human handoff. Appointment changes appear in your workspace.",
              ],
            ].map(([number, title, copy]) => (
              <li key={number}>
                <span>{number}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <ProductDemo />
        <section className="marketing-section proof-section" id="features">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                A receptionist connected to your business
              </p>
              <h2>
                Useful answers.
                <br />
                Thoughtful follow-through.
              </h2>
            </div>
            <p>
              Give AnaAI the essentials once. Keep your daily work in a
              workspace that makes sense at a glance.
            </p>
          </div>
          <div className="proof-grid">
            <article className="proof-knowledge">
              <p className="eyebrow">Understand / Business knowledge</p>
              <h3>
                The details that make
                <br />
                your business yours.
              </h3>
              <p>
                Services, opening hours, policies, and the answers your
                customers ask for most.
              </p>
              <div className="knowledge-composition">
                <div>
                  <BookOpen size={17} />
                  <span>What AnaAI knows</span>
                  <span>Example</span>
                </div>
                <details open>
                  <summary>Do I need to arrive early?</summary>
                  <p>
                    Please arrive five minutes before your appointment so we can
                    welcome you in.
                  </p>
                </details>
                <details>
                  <summary>What should I know before my visit?</summary>
                  <p>Your business can add its own preparation advice here.</p>
                </details>
              </div>
            </article>
            <article className="proof-appointments">
              <p className="eyebrow">Act / Appointment management</p>
              <h3>
                Plans change.
                <br />
                Keep the day together.
              </h3>
              <p>
                New bookings, reschedules, and cancellations belong in the same
                business calendar.
              </p>
              <div className="appointment-composition">
                <div>
                  <CalendarDays size={18} />
                  <strong>One schedule. A clearer day.</strong>
                </div>
                {[
                  ["10:00", "Cut & finish", "Confirmed"],
                  ["11:30", "Consultation", "Booked"],
                  ["14:30", "Cut & finish", "Rescheduled"],
                ].map(([time, service, state]) => (
                  <div key={time}>
                    <time>{time}</time>
                    <span>{service}</span>
                    <small>{state}</small>
                  </div>
                ))}
                <p>Fictional appointments shown for illustration</p>
              </div>
            </article>
          </div>
          <article className="handoff-story">
            <div className="handoff-mark">
              <PhoneForwarded size={32} />
              <span />
              <span />
            </div>
            <div>
              <p className="eyebrow">Hand off / Keep it human</p>
              <h3>
                Sometimes, a person
                <br />
                is the right next step.
              </h3>
              <p>
                When human handoff is configured, AnaAI can try to connect a
                caller to your business. Because taking care of people includes
                knowing when to involve you.
              </p>
            </div>
            <Link href="/signup" className="text-link">
              Make AnaAI yours <ArrowUpRight size={18} />
            </Link>
          </article>
        </section>
        <section className="use-cases" id="use-cases">
          <div className="marketing-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">For businesses built around people</p>
                <h2>
                  Different days.
                  <br />
                  The same need to be there.
                </h2>
              </div>
              <p>
                When your work needs your attention, a ringing phone shouldn’t
                have to take it away.
              </p>
            </div>
            <div className="use-case-grid">
              {[
                [
                  "01",
                  "Salon & barber",
                  "One more appointment, without stepping away from the chair.",
                  "Cut / Style / Finish",
                ],
                [
                  "02",
                  "Spa & wellness",
                  "Let the space stay calm while callers find their next visit.",
                  "Rest / Reset / Return",
                ],
                [
                  "03",
                  "Beauty & beyond",
                  "Answer the practical questions before the appointment begins.",
                  "Consult / Book / Welcome",
                ],
              ].map(([number, name, copy, details]) => (
                <article key={name}>
                  <span>{number}</span>
                  <div
                    className={`use-case-art art-${number}`}
                    aria-hidden="true"
                  >
                    <i />
                    <i />
                    <i />
                  </div>
                  <p className="eyebrow">{details}</p>
                  <h3>{name}</h3>
                  <p>{copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
        <section className="marketing-section faq-section" id="questions">
          <div>
            <p className="eyebrow">A few useful answers</p>
            <h2>
              Before you
              <br />
              say hello.
            </h2>
            <p>Clear expectations make a better start.</p>
          </div>
          <div>
            {questions.map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="closing-section">
          <VoiceLine />
          <p className="eyebrow">Make room for what you do best</p>
          <h2>
            A warm welcome.
            <br />
            Even when you’re busy.
          </h2>
          <Link className="marketing-button primary" href="/signup">
            Get started with AnaAI <ArrowUpRight size={19} />
          </Link>
          <p>
            <Check size={15} />
            Set up your business, services, and receptionist.
          </p>
        </section>
      </main>
      <footer className="marketing-footer">
        <div>
          <Link href="/" aria-label="AnaAI home">
            <Brand />
          </Link>
          <p>A little more care, from the first call.</p>
        </div>
        <nav aria-label="Footer navigation">
          <a href="#product">Product</a>
          <a href="#questions">Questions</a>
          <Link href="/login">Sign in</Link>
          <Link href="/signup">Get started</Link>
        </nav>
        <span>© {new Date().getFullYear()} AnaAI by ZUDE</span>
      </footer>
    </div>
  );
}
