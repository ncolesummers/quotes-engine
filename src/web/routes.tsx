import { Route, Switch, useSearchParams } from "wouter";
import { NotFoundPage, PlaceholderPage } from "@/pages/PlaceholderPage";
import { SearchPage } from "@/pages/SearchPage";

function QuoteDetailPlaceholder({ id }: { id: string }) {
  return (
    <PlaceholderPage title={`Quote #${id}`}>
      <p>Quote details, postings and editing arrive with #15.</p>
    </PlaceholderPage>
  );
}

function BooksPlaceholder() {
  const [params] = useSearchParams();
  const q = params.get("q");
  return (
    <PlaceholderPage title="Books">
      <p>{q ? `Book pages for “${q}” arrive with #25.` : "Book pages arrive with #25."}</p>
    </PlaceholderPage>
  );
}

/** Route table. Replace placeholders as their issues land (#15 quote detail, #25 books, ...). */
export function AppRoutes() {
  return (
    <Switch>
      <Route path="/" component={SearchPage} />
      <Route path="/quotes/:id">{(params) => <QuoteDetailPlaceholder id={params.id} />}</Route>
      <Route path="/books" component={BooksPlaceholder} />
      <Route path="/highlights">
        <PlaceholderPage title="Highlights">
          <p>Apple Books highlights waiting their turn arrive in a later issue.</p>
        </PlaceholderPage>
      </Route>
      <Route path="/review">
        <PlaceholderPage title="Review">
          <p>Post–quote links that need a second look arrive in a later issue.</p>
        </PlaceholderPage>
      </Route>
      <Route component={NotFoundPage} />
    </Switch>
  );
}
