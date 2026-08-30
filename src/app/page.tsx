export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <section className="w-full max-w-xl rounded-3xl border border-zinc-800 bg-zinc-900 p-8 shadow-2xl shadow-black/40 sm:p-10">
        <p className="mb-5 font-mono text-xs uppercase tracking-[0.24em] text-emerald-400">
          Build Week · M0
        </p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Autonomous DevOps Agent
        </h1>
        <p className="mt-5 text-lg leading-8 text-zinc-400">
          The isolated app, public GitHub repository, Convex development backend,
          and automatic Vercel deployment are connected.
        </p>
        <div className="mt-8 flex items-center gap-3 border-t border-zinc-800 pt-6 text-sm text-zinc-300">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_16px_rgba(52,211,153,0.7)]"
          />
          Setup pipeline is live
        </div>
      </section>
    </main>
  );
}
