import Link from "next/link";
import { ArrowLeft, Gamepad2 } from "lucide-react";

/**
 * The shell both legal pages sit in.
 *
 * They are plain server components with no state, so a static export ships
 * them as flat HTML and they cost nothing to serve.
 */
export default function LegalPage({
  title,
  intro,
  updated,
  children,
}: {
  title: string;
  intro: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <main className="relative min-h-screen bg-background">
      {/* Same wash of colour the landing page opens with, so this does not
          read as a page from a different site. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.18),transparent_70%)]" />

      <div className="relative mx-auto max-w-3xl px-6 py-12 sm:py-20">
        <header className="mb-12">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-text-secondary transition-colors hover:text-white"
          >
            <ArrowLeft size={16} />
            Back to PlayBuddies
          </Link>

          <div className="mt-8 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent">
              <Gamepad2 size={18} className="text-white" />
            </div>
            <span className="font-[family-name:var(--font-display)] text-lg font-bold">
              Play
              <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                Buddies
              </span>
            </span>
          </div>

          <h1 className="mt-8 font-[family-name:var(--font-display)] text-4xl font-black sm:text-5xl">
            {title}
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-text-secondary">{intro}</p>
          <p className="mt-4 text-sm text-text-muted">Last updated {updated}</p>
        </header>

        <div className="space-y-10">{children}</div>

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-white/5 pt-8 text-sm text-text-muted">
          <div className="flex gap-6">
            <Link href="/privacy" className="transition-colors hover:text-white">
              Privacy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-white">
              Terms
            </Link>
          </div>
          <span>© 2026 PlayBuddies by Bilal Saeed</span>
        </footer>
      </div>
    </main>
  );
}

/** One numbered section of a policy. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/5 bg-surface/40 p-6 sm:p-8">
      <h2 className="font-[family-name:var(--font-display)] text-xl font-bold text-white">
        {title}
      </h2>
      <div className="mt-4 space-y-4 leading-relaxed text-text-secondary">{children}</div>
    </section>
  );
}

/** A plain list. Used for "what is stored" and "what is not". */
export function Points({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
