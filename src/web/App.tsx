import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Router } from "wouter";
import { AppShell } from "@/components/AppShell";
import { createQueryClient } from "@/lib/query";
import { AppRoutes } from "@/routes";

/** Shell + routes, without providers (tests wrap this with a memory router and test client). */
export function AppContent() {
  return (
    <AppShell>
      <AppRoutes />
    </AppShell>
  );
}

export function App({ queryClient }: { queryClient?: QueryClient } = {}) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <QueryClientProvider client={client}>
      <Router>
        <AppContent />
      </Router>
    </QueryClientProvider>
  );
}
