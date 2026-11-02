import { useMutation } from "@tanstack/react-query";
import { PencilIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useId,
  useImperativeHandle,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface InlineEditProps {
  /** Field name used in labels: "Edit {noun}" / "Add {noun}". */
  noun: string;
  /** Accessible label for the input. */
  label: string;
  value: string | null;
  /** Saves the trimmed draft; null means the field was cleared (only when not `required`). */
  onSave: (value: string | null) => Promise<unknown>;
  /** Display for a non-empty value. */
  children: (value: string) => ReactNode;
  multiline?: boolean;
  /** A required field can't be cleared (Save is disabled while the draft is blank). */
  required?: boolean;
  placeholder?: string;
  /** Custom error display; defaults to the error message. */
  renderError?: (error: Error, draft: string) => ReactNode;
  inputClassName?: string;
  className?: string;
  /** Lets a parent start editing, e.g. from a keyboard shortcut. */
  editRef?: Ref<InlineEditHandle>;
}

export interface InlineEditHandle {
  /** Switch to the input (no-op while already editing). */
  edit(): void;
}

/**
 * A value shown as-is with a small pencil button; editing swaps in an input with Save/Cancel.
 * Enter saves single-line fields, ⌘/Ctrl+Enter saves multi-line ones, Escape cancels. On
 * failure the draft is kept and the error shown in place.
 */
export function InlineEdit({
  noun,
  label,
  value,
  onSave,
  children,
  multiline = false,
  required = false,
  placeholder,
  renderError,
  inputClassName,
  className,
  editRef,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const errorId = useId();

  const mutation = useMutation({
    mutationFn: (next: string | null) => onSave(next),
    onSuccess: () => setEditing(false),
  });

  const start = () => {
    mutation.reset();
    setDraft(value ?? "");
    setEditing(true);
  };
  useImperativeHandle(editRef, () => ({ edit: () => (editing ? undefined : start()) }));
  const cancel = () => {
    mutation.reset();
    setEditing(false);
  };
  const trimmed = draft.trim();
  const blocked = required && trimmed === "";
  const save = () => {
    if (blocked || mutation.isPending) return;
    const next = trimmed === "" ? null : trimmed;
    if (next === (value ?? null)) return cancel();
    mutation.mutate(next);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // Enter/Escape while an IME is composing belong to the IME (229: Safari's composing code).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  };

  if (!editing) {
    const action = `${value ? "Edit" : "Add"} ${noun}`;
    return value ? (
      <span className={cn("group/edit", className)}>
        {children(value)}
        <button
          type="button"
          onClick={start}
          aria-label={action}
          title={action}
          className="ml-1.5 inline-flex size-6 translate-y-[-0.1em] items-center justify-center rounded-md align-middle text-muted-foreground opacity-50 transition-opacity outline-none group-hover/edit:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <PencilIcon aria-hidden className="size-3.5" />
        </button>
      </span>
    ) : (
      <button
        type="button"
        onClick={start}
        className={cn(
          "rounded-sm text-sm text-muted-foreground italic underline decoration-dotted underline-offset-4 outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50",
          className,
        )}
      >
        {action}
      </button>
    );
  }

  const error = mutation.error;
  const shared = {
    id: inputId,
    "aria-label": label,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? errorId : undefined,
    value: draft,
    placeholder,
    autoFocus: true,
    onKeyDown,
  };

  return (
    <div className={cn("flex w-full flex-col gap-2", className)}>
      {multiline ? (
        <textarea
          {...shared}
          rows={Math.min(8, Math.max(3, Math.ceil(draft.length / 60)))}
          onChange={(e) => setDraft(e.target.value)}
          className={cn(
            "w-full resize-y rounded-md border border-input bg-card px-3 py-2 shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive",
            inputClassName,
          )}
        />
      ) : (
        <Input
          {...shared}
          onChange={(e) => setDraft(e.target.value)}
          className={cn("bg-card", inputClassName)}
        />
      )}
      {error && (
        <div id={errorId} role="alert" className="text-sm text-destructive">
          {renderError ? renderError(error, trimmed) : error.message}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={blocked || mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel} disabled={mutation.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
