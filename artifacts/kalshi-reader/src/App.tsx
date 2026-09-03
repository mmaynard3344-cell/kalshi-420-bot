import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { checkSessionAndRecover } from '@/lib/sessionGuard';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import Operator from '@/pages/Operator';
import LiveMartingale from '@/pages/LiveMartingale';
import Dashboard from '@/pages/Dashboard';
import { Route, Switch, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: () => {
      void checkSessionAndRecover();
    },
  }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30000,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '') || ''}>
          <Switch>
            <Route path="/" component={Operator} />
            <Route path="/legacy" component={LiveMartingale} />
            <Route path="/analytics" component={Dashboard} />
            <Route>
              <div className="min-h-screen flex items-center justify-center font-mono text-muted-foreground p-4">
                404 | Terminal Route Not Found
              </div>
            </Route>
          </Switch>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
