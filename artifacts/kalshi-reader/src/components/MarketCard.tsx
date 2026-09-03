import { Link } from 'wouter';
import type { Market } from '@workspace/api-client-react';
import { formatPrice, formatVolume } from '@/lib/utils';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MarketCardProps {
  market: Market;
}

export function MarketCard({ market }: MarketCardProps) {
  const priceChange = market.last_price && market.previous_price
    ? market.last_price - market.previous_price
    : null;

  return (
    <Link
      href={`/markets/${market.ticker}`}
      className="block p-4 border border-card-border bg-card rounded-md hover:border-primary/50 transition-all hover:shadow-sm"
      data-testid={`card-market-${market.ticker}`}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm text-foreground leading-tight mb-1 line-clamp-2">
            {market.title}
          </h3>
          {market.subtitle && (
            <p className="text-xs text-muted-foreground line-clamp-1">
              {market.subtitle}
            </p>
          )}
        </div>
        {market.status && (
          <span className={cn(
            "px-2 py-0.5 text-xs font-medium rounded uppercase shrink-0",
            market.status === 'open' && "bg-chart-3/10 text-chart-3",
            market.status === 'closed' && "bg-muted text-muted-foreground",
            market.status === 'settled' && "bg-primary/10 text-primary"
          )} data-testid={`status-${market.ticker}`}>
            {market.status}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <div className="text-xs text-muted-foreground mb-1">Yes</div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-mono-tabular font-semibold text-primary" data-testid={`yes-price-${market.ticker}`}>
              {formatPrice(market.yes_bid)}
            </span>
            <span className="text-xs text-muted-foreground font-mono-tabular">
              {formatPrice(market.yes_ask)}
            </span>
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">No</div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-mono-tabular font-semibold text-accent" data-testid={`no-price-${market.ticker}`}>
              {formatPrice(market.no_bid)}
            </span>
            <span className="text-xs text-muted-foreground font-mono-tabular">
              {formatPrice(market.no_ask)}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-3">
          {market.volume_24h !== null && market.volume_24h !== undefined && (
            <div className="text-muted-foreground">
              Vol: <span className="font-mono-tabular font-medium text-foreground" data-testid={`volume-${market.ticker}`}>{formatVolume(market.volume_24h)}</span>
            </div>
          )}
          {market.open_interest !== null && market.open_interest !== undefined && (
            <div className="text-muted-foreground">
              OI: <span className="font-mono-tabular font-medium text-foreground">{formatVolume(market.open_interest)}</span>
            </div>
          )}
        </div>
        {priceChange !== null && (
          <div className={cn(
            "flex items-center gap-1 font-mono-tabular font-medium",
            priceChange > 0 ? "text-chart-3" : priceChange < 0 ? "text-destructive" : "text-muted-foreground"
          )}>
            {priceChange > 0 ? <TrendingUp className="h-3 w-3" /> : priceChange < 0 ? <TrendingDown className="h-3 w-3" /> : null}
            {priceChange > 0 ? '+' : ''}{priceChange}¢
          </div>
        )}
      </div>
    </Link>
  );
}
