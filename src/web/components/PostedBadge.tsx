import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** "Posted N×": quiet for a single posting, accented for reposts (N ≥ 2). */
export function PostedBadge({ count, className }: { count: number; className?: string }) {
  if (count === 0) {
    return (
      <Badge
        variant="outline"
        data-reposted="false"
        className={cn("border-dashed font-normal text-muted-foreground", className)}
      >
        Not yet posted
      </Badge>
    );
  }
  const reposted = count >= 2;
  return (
    <Badge
      variant={reposted ? "default" : "outline"}
      data-reposted={String(reposted)}
      title={reposted ? `Posted ${count} times` : "Posted once"}
      className={cn(
        "tabular-nums",
        reposted ? "bg-primary font-semibold shadow-xs" : "font-normal text-muted-foreground",
        className,
      )}
    >
      {`Posted ${count}×`}
    </Badge>
  );
}
