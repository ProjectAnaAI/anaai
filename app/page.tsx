export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-white">

      {/* Navigation */}

      <nav className="flex items-center justify-between px-10 py-6">

        <h1 className="text-2xl font-bold text-cyan-400">
          AnaAI
        </h1>

        <div className="flex gap-8 text-gray-300">
          <a href="#">Features</a>
          <a href="#">Pricing</a>
          <a href="#">About</a>
          <a href="#">Contact</a>
        </div>

        <button className="rounded-xl bg-cyan-500 px-5 py-2 font-semibold text-black hover:bg-cyan-400">
          Book Demo
        </button>

      </nav>

      {/* Hero */}

      <section className="flex flex-col items-center justify-center px-6 text-center mt-24">

        <p className="uppercase tracking-[0.3em] text-cyan-400">
          AI Receptionist for Salons
        </p>

        <h1 className="mt-6 max-w-5xl text-6xl font-extrabold">
          Never Miss Another Customer Call
        </h1>

        <p className="mt-8 max-w-3xl text-xl text-gray-300">
          AnaAI answers every call, books appointments automatically,
          answers customer questions, and lets salon owners focus on
          growing their business.
        </p>

        <div className="mt-12 flex gap-5">

          <button className="rounded-xl bg-cyan-500 px-8 py-4 font-bold text-black hover:bg-cyan-400">
            Get Started
          </button>

          <button className="rounded-xl border border-gray-600 px-8 py-4 hover:border-white">
            Watch Demo
          </button>

        </div>

      </section>

    </main>
  );
}<section className="bg-black py-24 px-10">

  <h2 className="text-center text-4xl font-bold">
    Why Salons Choose AnaAI
  </h2>

  <div className="mt-16 grid gap-8 md:grid-cols-2 lg:grid-cols-4">

    <div className="rounded-2xl bg-gray-900 p-6">
      <h3 className="text-xl font-bold text-cyan-400">
        📞 AI Receptionist
      </h3>

      <p className="mt-3 text-gray-300">
        Answers every customer call 24/7.
      </p>
    </div>

    <div className="rounded-2xl bg-gray-900 p-6">
      <h3 className="text-xl font-bold text-cyan-400">
        📅 Smart Booking
      </h3>

      <p className="mt-3 text-gray-300">
        Books appointments automatically.
      </p>
    </div>

    <div className="rounded-2xl bg-gray-900 p-6">
      <h3 className="text-xl font-bold text-cyan-400">
        👥 Customer History
      </h3>

      <p className="mt-3 text-gray-300">
        Stores customer information securely.
      </p>
    </div>

    <div className="rounded-2xl bg-gray-900 p-6">
      <h3 className="text-xl font-bold text-cyan-400">
        📊 Business Dashboard
      </h3>

      <p className="mt-3 text-gray-300">
        View bookings and appointments in real time.
      </p>
    </div>

  </div>

</section>