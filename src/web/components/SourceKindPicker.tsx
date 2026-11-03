import { useMutation } from "@tanstack/react-query";
import type { SourceKind } from "@/api";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SOURCE_KIND_LABELS, SOURCE_KINDS } from "@/lib/source-kind";
import { cn } from "@/lib/utils";

const toggleOn = "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";

/** Book / Song / Other for a quote; saving "Song" or "Other" unlinks its book (#42). */
export function SourceKindPicker({
  value,
  onSave,
  className,
}: {
  value: SourceKind;
  onSave: (kind: SourceKind) => Promise<unknown>;
  className?: string;
}) {
  const mutation = useMutation({ mutationFn: (kind: SourceKind) => onSave(kind) });
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={mutation.isPending ? mutation.variables : value}
        disabled={mutation.isPending}
        onValueChange={(next) => {
          if (next && next !== value) mutation.mutate(next as SourceKind);
        }}
        aria-label="Source type"
      >
        {SOURCE_KINDS.map((kind) => (
          <ToggleGroupItem key={kind} value={kind} className={cn("h-7 px-2.5 text-xs", toggleOn)}>
            {SOURCE_KIND_LABELS[kind].option}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {mutation.error && (
        <span role="alert" className="text-sm text-destructive">
          {mutation.error.message}
        </span>
      )}
    </div>
  );
}
