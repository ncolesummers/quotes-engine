import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Quotes Engine</h1>
        <p className="text-muted-foreground">
          Every quote posted to Instagram, plus Apple Books highlights waiting their turn.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Search quotes</CardTitle>
          <CardDescription>
            Nothing is synced yet. Search arrives in a later milestone.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input placeholder="Search by text or author" aria-label="Search quotes" disabled />
          <Button type="button" disabled>
            Search
          </Button>
        </CardContent>
        <CardFooter>
          <Badge variant="secondary">Scaffold</Badge>
        </CardFooter>
      </Card>
    </main>
  );
}
