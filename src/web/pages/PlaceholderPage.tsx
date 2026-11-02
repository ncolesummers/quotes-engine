import type { ReactNode } from "react";
import { Link } from "wouter";

/** Stand-in for routes whose pages land in later issues. */
export function PlaceholderPage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 py-8">
      <h1 className="font-serif text-3xl font-medium tracking-tight">{title}</h1>
      <div className="text-muted-foreground">{children ?? <p>Coming soon.</p>}</div>
      <Link href="/" className="text-sm text-primary underline-offset-4 hover:underline">
        ← Back to quotes
      </Link>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <PlaceholderPage title="Not found">
      <p>There’s no page here.</p>
    </PlaceholderPage>
  );
}
