import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center text-center px-6 py-24">
      <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-6">
        Account Demolisher Docs
      </h1>
      <p className="max-w-2xl text-base sm:text-lg text-fd-muted-foreground mb-8 leading-relaxed">
        How to use the demolisher, how the closure plan is built, what the mediator account does,
        and how to revoke token allowances.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/docs"
          className="inline-flex items-center gap-2 rounded-md bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground hover:opacity-90"
        >
          Read the docs
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Link>
        <a
          href="https://demolisher.app"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-medium text-fd-card-foreground hover:bg-fd-accent"
        >
          Open the live app
        </a>
        <a
          href="https://github.com/bytemaster333/account-demolisher"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-medium text-fd-card-foreground hover:bg-fd-accent"
        >
          GitHub
        </a>
      </div>
    </main>
  );
}
