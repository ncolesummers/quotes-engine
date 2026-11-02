import { Route, Switch } from "wouter";
import { BookDetailPage } from "@/pages/BookDetailPage";
import { BooksPage } from "@/pages/BooksPage";
import { NotFoundPage, PlaceholderPage } from "@/pages/PlaceholderPage";
import { QuoteDetailPage } from "@/pages/QuoteDetailPage";
import { ReviewPage } from "@/pages/ReviewPage";
import { SearchPage } from "@/pages/SearchPage";

/** Route table. Replace placeholders as their issues land. */
export function AppRoutes() {
  return (
    <Switch>
      <Route path="/" component={SearchPage} />
      <Route path="/quotes/:id">
        {/* Keyed so another quote starts fresh (no drafts or dialog state carried over). */}
        {(params) => <QuoteDetailPage key={params.id} id={params.id} />}
      </Route>
      <Route path="/books" component={BooksPage} />
      <Route path="/books/:id">
        {(params) => <BookDetailPage key={params.id} id={params.id} />}
      </Route>
      <Route path="/highlights">
        <PlaceholderPage title="Highlights">
          <p>Apple Books highlights waiting their turn arrive in a later issue.</p>
        </PlaceholderPage>
      </Route>
      <Route path="/review" component={ReviewPage} />
      <Route component={NotFoundPage} />
    </Switch>
  );
}
