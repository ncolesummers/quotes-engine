import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronsUpDownIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { fetchAuthors, fetchBooks } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatNumber } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { PostedFilter, QuoteFilters } from "@/lib/quote-filters";
import { cn } from "@/lib/utils";

export type SetFilters = (change: Partial<QuoteFilters>) => void;

const BOOK_LIST = { sort: "title" } as const;

/** Every book, by title: the book picker's options and the book chip's label. */
export function useBookOptions(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.books.list(BOOK_LIST),
    queryFn: () => fetchBooks(BOOK_LIST),
    select: (data) => data.items,
    enabled,
  });
}

function useAuthorOptions(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.authors, queryFn: fetchAuthors, enabled });
}

interface ComboOption {
  value: string;
  label: string;
  /** Second line, e.g. a book's author. Searched too. */
  hint?: string | null;
  count?: number;
}

/** Case-insensitive substring match on the label and hint (cmdk's default is fuzzy). */
function substringFilter(_value: string, search: string, keywords?: string[]): number {
  const needle = search.trim().toLowerCase();
  return (keywords ?? []).join(" ").toLowerCase().includes(needle) ? 1 : 0;
}

/** A searchable single-pick list in a popover (shadcn combobox pattern). */
function FilterCombobox({
  label,
  anyLabel,
  searchLabel,
  emptyText,
  value,
  valueLabel,
  options,
  loading,
  error,
  onOpen,
  onChange,
}: {
  label: string;
  anyLabel: string;
  searchLabel: string;
  emptyText: string;
  value: string | null;
  valueLabel: string | null;
  options: ComboOption[];
  loading: boolean;
  error: boolean;
  onOpen?: () => void;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant={value ? "secondary" : "outline"}
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={value ? `${label}: ${valueLabel ?? value}` : label}
          className="h-8 max-w-56 justify-between gap-1.5 font-normal"
        >
          <span className="truncate">
            {value ? (valueLabel ?? value) : <span className="text-muted-foreground">{label}</span>}
          </span>
          <ChevronsUpDownIcon aria-hidden className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command filter={substringFilter}>
          <CommandInput placeholder={`${searchLabel}…`} aria-label={searchLabel} />
          <CommandList>
            {loading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : error ? (
              <p role="alert" className="py-6 text-center text-sm text-destructive">
                Couldn’t load the list.
              </p>
            ) : (
              <>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup>
                  {value && (
                    <CommandItem value="__any__" keywords={[]} onSelect={() => choose(null)}>
                      <span className="text-muted-foreground italic">{anyLabel}</span>
                    </CommandItem>
                  )}
                  {options.map((o) => (
                    <CommandItem
                      key={o.value}
                      value={o.value}
                      keywords={[o.label, o.hint ?? ""]}
                      onSelect={() => choose(o.value)}
                      className="items-start"
                    >
                      <CheckIcon
                        aria-hidden
                        className={cn("mt-0.5", o.value === value ? "opacity-100" : "opacity-0")}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{o.label}</span>
                        {o.hint && (
                          <span className="truncate text-xs text-muted-foreground">{o.hint}</span>
                        )}
                      </span>
                      {o.count !== undefined && (
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                          {formatNumber(o.count)}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AuthorFilter({ value, onChange }: { value: string | null; onChange: SetFilters }) {
  // Fetched on first open: the trigger and chip only need the name, which is in the URL.
  const [wanted, setWanted] = useState(false);
  const authors = useAuthorOptions(wanted);
  return (
    <FilterCombobox
      label="Author"
      anyLabel="Any author"
      searchLabel="Search authors"
      emptyText="No author by that name."
      value={value}
      valueLabel={value}
      options={(authors.data ?? []).map((a) => ({
        value: a.name,
        label: a.name,
        count: a.quoteCount,
      }))}
      loading={authors.isPending && wanted}
      error={authors.isError}
      onOpen={() => setWanted(true)}
      onChange={(author) => onChange({ author })}
    />
  );
}

/** A book's display title. */
export function bookLabel(book: { id: number; title: string | null } | undefined, id: number) {
  return book ? (book.title ?? "Untitled book") : `Book #${id}`;
}

function BookFilter({ value, onChange }: { value: number | null; onChange: SetFilters }) {
  // Fetched on first open, or at once when the URL already names a book (for its title).
  const [wanted, setWanted] = useState(false);
  const books = useBookOptions(wanted || value !== null);
  const items = books.data ?? [];
  const current = value === null ? null : items.find((b) => b.id === value);
  return (
    <FilterCombobox
      label="Book"
      anyLabel="Any book"
      searchLabel="Search books"
      emptyText="No book by that title."
      value={value === null ? null : String(value)}
      valueLabel={
        value === null ? null : books.isPending ? "…" : bookLabel(current ?? undefined, value)
      }
      options={items.map((b) => ({
        value: String(b.id),
        label: b.title ?? "Untitled book",
        hint: b.author,
        count: b.quoteCount,
      }))}
      loading={books.isPending}
      error={books.isError}
      onOpen={() => setWanted(true)}
      onChange={(id) => onChange({ bookId: id === null ? null : Number(id) })}
    />
  );
}

const POSTED: { value: PostedFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "yes", label: "Posted" },
  { value: "no", label: "Never posted" },
];

const toggleOn = "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";

/** Author, book, posted, reposted and no-book controls. */
export function FilterControls({
  filters,
  onChange,
  className,
}: {
  filters: QuoteFilters;
  onChange: SetFilters;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <AuthorFilter value={filters.author} onChange={onChange} />
      <BookFilter value={filters.bookId} onChange={onChange} />
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={filters.posted}
        onValueChange={(v) => v && onChange({ posted: v as PostedFilter })}
        aria-label="Posted"
      >
        {POSTED.map((p) => (
          <ToggleGroupItem key={p.value} value={p.value} className={cn("px-2.5", toggleOn)}>
            {p.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Button
        variant={filters.reposted ? "default" : "outline"}
        size="sm"
        aria-pressed={filters.reposted}
        onClick={() => onChange({ reposted: !filters.reposted })}
        title="Quotes posted two or more times"
        className="h-8"
      >
        Reposted only
      </Button>
      <Button
        variant={filters.noBook ? "default" : "outline"}
        size="sm"
        aria-pressed={filters.noBook}
        onClick={() => onChange({ noBook: !filters.noBook })}
        title="Quotes not linked to any book"
        className="h-8"
      >
        No book
      </Button>
    </div>
  );
}

/** Small screens: the filter controls behind a "Filters" button. */
export function MobileFilters({
  filters,
  activeCount,
  onChange,
}: {
  filters: QuoteFilters;
  activeCount: number;
  onChange: SetFilters;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 sm:hidden">
          <SlidersHorizontalIcon aria-hidden />
          Filters
          {activeCount > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground tabular-nums">
              {activeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Filters"
        className="w-[min(22rem,calc(100vw-2rem))]"
      >
        <FilterControls filters={filters} onChange={onChange} className="items-start" />
      </PopoverContent>
    </Popover>
  );
}

export interface FilterChip {
  key: string;
  label: string;
  /** What the chip filters on, for screen readers ("Author", "Book"...). */
  kind: string;
  remove: () => void;
}

/** Active filters as removable chips, plus "Clear filters". */
export function FilterChips({ chips, onClear }: { chips: FilterChip[]; onClear: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ul aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <li
            key={chip.key}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/30 bg-primary/5 py-0.5 pr-1 pl-3 text-sm text-foreground"
          >
            <span className="sr-only">{chip.kind}: </span>
            <span className="truncate">{chip.label}</span>
            <button
              type="button"
              onClick={chip.remove}
              aria-label={`Remove filter: ${chip.kind}: ${chip.label}`}
              className="rounded-full p-0.5 text-muted-foreground outline-none hover:bg-primary/10 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClear}
        className="h-7 px-2 text-muted-foreground"
      >
        Clear filters
      </Button>
    </div>
  );
}
