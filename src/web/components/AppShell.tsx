import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useRoute } from "wouter";
import { fetchStats } from "@/api";
import { Badge } from "@/components/ui/badge";
import { queryKeys } from "@/lib/query";
import { cn } from "@/lib/utils";
import { StatsStrip } from "./StatsStrip";
import { ThemeToggle } from "./ThemeToggle";

/** Nav targets; `match` is the wouter pattern that marks the link as current. */
const NAV = [
  { href: "/", label: "Quotes", match: "/" },
  { href: "/books", label: "Books", match: "/books/*?" },
  { href: "/highlights", label: "Highlights", match: "/highlights/*?" },
  { href: "/review", label: "Review", match: "/review/*?" },
] as const;

function NavLink({
  href,
  match,
  children,
  ariaLabel,
}: {
  href: string;
  match: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  const [quoteDetail] = useRoute("/quotes/*");
  const [matched] = useRoute(match);
  // Quote detail pages belong to the Quotes section.
  const active = matched || (href === "/" && quoteDetail);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={ariaLabel}
      className={cn(
        "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
        "text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none",
        active &&
          "text-foreground after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
      )}
    >
      {children}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const stats = useQuery({ queryKey: queryKeys.stats, queryFn: fetchStats });
  const needsReview = stats.data?.needsReview ?? 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/70">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 pt-6 pb-3 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <Link
              href="/"
              className="font-serif text-2xl font-medium tracking-tight italic outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Quotes Engine
            </Link>
            <ThemeToggle />
          </div>
          <nav aria-label="Primary" className="-mx-2.5 overflow-x-auto">
            <ul className="flex items-center gap-1">
              {NAV.map((item) => {
                const showBadge = item.href === "/review" && needsReview > 0;
                return (
                  <li key={item.href}>
                    <NavLink
                      href={item.href}
                      match={item.match}
                      ariaLabel={
                        showBadge ? `${item.label}, ${needsReview} awaiting review` : undefined
                      }
                    >
                      {item.label}
                      {showBadge && (
                        <Badge className="h-5 min-w-5 px-1.5 tabular-nums">{needsReview}</Badge>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </nav>
          <StatsStrip stats={stats.data} failed={stats.isError} />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">{children}</main>
    </div>
  );
}
