import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Router as WouterRouter, Redirect } from "wouter";
import { AuthProvider, useAuth } from "@/lib/auth";
import LoginPage from "@/pages/login";
import PackagesPage from "@/pages/packages";
import DashboardPage from "@/pages/dashboard";
import SessionsPage from "@/pages/sessions";
import LoyaltyPage from "@/pages/loyalty";
import ProfilePage from "@/pages/profile";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

function ProtectedRoute({
  component: Component,
}: {
  component: React.ComponentType;
}) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Redirect to="/login" />;
  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/packages" component={PackagesPage} />
      <Route path="/" component={() => <Redirect to="/packages" />} />
      <Route
        path="/dashboard"
        component={() => <ProtectedRoute component={DashboardPage} />}
      />
      <Route
        path="/sessions"
        component={() => <ProtectedRoute component={SessionsPage} />}
      />
      <Route
        path="/loyalty"
        component={() => <ProtectedRoute component={LoyaltyPage} />}
      />
      <Route
        path="/profile"
        component={() => <ProtectedRoute component={ProfilePage} />}
      />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
