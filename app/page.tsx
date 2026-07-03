export default function Home() {
  return (
    <main className="min-h-screen bg-white text-gray-900">

      {/* ================= NAVBAR ================= */}
      <nav className="sticky top-0 z-50 flex items-center justify-between border-b border-gray-200 bg-white px-10 py-5">

        <h1 className="text-3xl font-extrabold text-green-600">
          AnaAI
        </h1>

        <div className="hidden md:flex gap-10 text-gray-600 font-medium">
          <a href="#" className="hover:text-green-600 transition">
            Features
          </a>

          <a href="#" className="hover:text-green-600 transition">
            Pricing
          </a>

          <a href="#" className="hover:text-green-600 transition">
            About
          </a>

          <a href="#" className="hover:text-green-600 transition">
            Contact
          </a>
        </div>

        <button className="rounded-xl bg-green-600 px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-green-700">
          Book Demo
        </button>

      </nav>

      {/* ================= HERO ================= */}

      <section className="mx-auto flex max-w-6xl flex-col items-center px-6 py-28 text-center">

        <p className="rounded-full bg-green-50 px-5 py-2 text-sm font-semibold uppercase tracking-[0.3em] text-green-600">
          AI Receptionist For Salons
        </p>

        <h1 className="mt-10 max-w-5xl text-6xl font-extrabold leading-tight md:text-7xl">
          Never Miss Another
          <br />
          Customer Call
        </h1>

        <p className="mt-8 max-w-3xl text-xl leading-9 text-gray-600">
          AnaAI answers every customer call, books appointments automatically,
          answers customer questions, and helps your salon grow 24/7.
        </p>

        <div className="mt-14 flex flex-wrap justify-center gap-5">

          <button className="rounded-xl bg-green-600 px-8 py-4 font-semibold text-white shadow transition hover:bg-green-700">
            Get Started
          </button>

          <button className="rounded-xl border border-gray-300 bg-white px-8 py-4 font-semibold text-gray-800 transition hover:bg-gray-100">
            Watch Demo
          </button>

        </div>

      </section>

      {/* ================= FEATURES ================= */}

      <section className="mx-auto max-w-7xl px-10 py-20">

        <h2 className="text-center text-5xl font-bold">
          Everything Your Salon Needs
        </h2>

        <p className="mx-auto mt-6 max-w-3xl text-center text-lg text-gray-500">
          AnaAI works like your smartest receptionist, available 24 hours a day,
          every day.
        </p>

        <div className="mt-16 grid gap-8 md:grid-cols-3">

          {/* CARD */}

          <div className="rounded-3xl border border-gray-200 bg-white p-8 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">

            <div className="mb-6 text-5xl">
              
            </div>

            <h3 className="text-2xl font-bold text-green-600">
              24/7 Receptionist
            </h3>

            <p className="mt-4 text-gray-600 leading-8">
              Never miss another customer call. AnaAI answers every call,
              even while you're busy.
            </p>

          </div>

          {/* CARD */}

          <div className="rounded-3xl border border-gray-200 bg-white p-8 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">

            <div className="mb-6 text-5xl">
             
            </div>

            <h3 className="text-2xl font-bold text-green-600">
              Smart Booking
            </h3>

            <p className="mt-4 text-gray-600 leading-8">
              Automatically books appointments into your schedule without
              lifting a finger.
            </p>

          </div>

          {/* CARD */}

          <div className="rounded-3xl border border-gray-200 bg-white p-8 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">

            <div className="mb-6 text-5xl">
              
            </div>

            <h3 className="text-2xl font-bold text-green-600">
              AI Assistant
            </h3>

            <p className="mt-4 text-gray-600 leading-8">
              Instantly answers customer questions about services, pricing,
              opening hours, and much more.
            </p>

          </div>

        </div>

      </section>

      {/* ================= CTA ================= */}

      <section className="mx-auto max-w-6xl px-8 py-24">

        <div className="rounded-3xl bg-green-50 p-16 text-center">

          <h2 className="text-5xl font-bold">
            Ready to Grow Your Salon?
          </h2>

          <p className="mx-auto mt-6 max-w-2xl text-xl text-gray-600">
            Join salon owners using AnaAI to automate bookings,
            answer every call, and provide a better customer experience.
          </p>

          <div className="mt-10 flex flex-wrap justify-center gap-5">

            <button className="rounded-xl bg-green-600 px-8 py-4 font-semibold text-white shadow transition hover:bg-green-700">
              Start Free Trial
            </button>

            <button className="rounded-xl border border-gray-300 bg-white px-8 py-4 font-semibold transition hover:bg-gray-100">
              Book Demo
            </button>

          </div>

        </div>

      </section>

      {/* ================= FOOTER ================= */}

      <footer className="border-t border-gray-200 py-12 text-center">

        <h3 className="text-3xl font-bold text-green-600">
          AnaAI
        </h3>

        <p className="mt-3 text-gray-500">
          AI Receptionist for Modern Salons
        </p>

        <p className="mt-6 text-sm text-gray-400">
          © {new Date().getFullYear()} AnaAI. All rights reserved.
        </p>

      </footer>

    </main>
  );
}