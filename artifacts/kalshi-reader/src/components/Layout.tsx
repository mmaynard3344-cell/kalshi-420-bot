import { Link, useRoute } from 'wouter';
import { BarChart3, TrendingUp, Building2, Wallet, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [isDashboard] = useRoute('/');
  const [isMarkets] = useRoute('/markets');
  const [isMarketDetail] = useRoute('/markets/:ticker');
  const [isPortfolio] = useRoute('/portfolio');
  const [isWhatIf] = useRoute('/what-if');

  return (
    <div className="min-h-[100dvh] bg-background">
      <nav className="border-b border-border bg-card">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8">
          <div className="flex h-14 items-center justify-between">
            <div className="flex items-center gap-8">
              <Link href="/" className="flex items-center gap-2 text-foreground hover:text-primary transition-colors">
                <BarChart3 className="h-5 w-5" />
                <span className="font-semibold text-base tracking-tight">
                  Kalshi 15-Min
                </span>
              </Link>
              <div className="flex items-center gap-1">
                <Link
                  href="/"
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                    isDashboard
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                  data-testid="link-dashboard"
                >
                  <TrendingUp className="h-4 w-4" />
                  BTC / ETH
                </Link>
                <Link
                  href="/markets"
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                    isMarkets || isMarketDetail
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                  data-testid="link-markets"
                >
                  <Building2 className="h-4 w-4" />
                  All Markets
                </Link>
                <Link
                  href="/portfolio"
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                    isPortfolio
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                >
                  <Wallet className="h-4 w-4" />
                  Portfolio
                </Link>
                <Link
                  href="/what-if"
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                    isWhatIf
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                  data-testid="link-what-if"
                >
                  <FlaskConical className="h-4 w-4" />
                  What-If
                </Link>
              </div>
            </div>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8 py-6">
        {children}
      </main>
    </div>
  );
}
