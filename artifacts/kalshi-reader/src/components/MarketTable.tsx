import { Link } from 'wouter';
import type { Market } from '@workspace/api-client-react';
import { formatPrice, formatVolume } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface MarketTableProps {
  markets: Market[];
}

export function MarketTable({ markets }: MarketTableProps) {
  if (markets.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No markets found
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-card-border rounded-md">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border bg-muted/30">
            <th className="text-left p-3 font-semibold text-xs uppercase tracking-wide text-muted-foreground">Market</th>
            <th className="text-right p-3 font-semibold text-xs uppercase tracking-wide text-muted-foreground">Yes Bid</th>
            <th className="text-right p-3 font-semibold text-xs uppercase tracking-wide text-muted-foreground">Yes Ask</th>
            <th className="text-right p-3 font-semibold text-xs uppercase tracking-wide text-muted-foreground">No Bid</th>
            <th className="text-right p-3 font-semibold text-xs uppercase tracking-wide text-muted-foreground">No Ask</th>
            <th className="text-right p-3 font-semibold text-xs uppercase tracking-wide text-muted-foreground">Volume</th>
            <th className="text-center p-3 font-semibold text-xs uppercase tracking-wide text-muted-foreground">Status</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((market) => (
            <tr
              key={market.ticker}
              className="border-b border-card-border last:border-0 hover:bg-muted/20 transition-colors"
              data-testid={`row-market-${market.ticker}`}
            >
              <td className="p-3">
                <Link
                  href={`/markets/${market.ticker}`}
                  className="font-medium text-foreground hover:text-primary transition-colors line-clamp-2"
                  data-testid={`link-market-${market.ticker}`}
                >
                  {market.title}
                </Link>
                {market.subtitle && (
                  <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                    {market.subtitle}
                  </div>
                )}
              </td>
              <td className="p-3 text-right font-mono-tabular text-primary font-semibold" data-testid={`yes-bid-${market.ticker}`}>
                {formatPrice(market.yes_bid)}
              </td>
              <td className="p-3 text-right font-mono-tabular text-muted-foreground" data-testid={`yes-ask-${market.ticker}`}>
                {formatPrice(market.yes_ask)}
              </td>
              <td className="p-3 text-right font-mono-tabular text-accent font-semibold" data-testid={`no-bid-${market.ticker}`}>
                {formatPrice(market.no_bid)}
              </td>
              <td className="p-3 text-right font-mono-tabular text-muted-foreground" data-testid={`no-ask-${market.ticker}`}>
                {formatPrice(market.no_ask)}
              </td>
              <td className="p-3 text-right font-mono-tabular" data-testid={`volume-${market.ticker}`}>
                {formatVolume(market.volume_24h)}
              </td>
              <td className="p-3 text-center">
                <span className={cn(
                  "inline-block px-2 py-0.5 text-xs font-medium rounded uppercase",
                  market.status === 'open' && "bg-chart-3/10 text-chart-3",
                  market.status === 'closed' && "bg-muted text-muted-foreground",
                  market.status === 'settled' && "bg-primary/10 text-primary"
                )} data-testid={`status-${market.ticker}`}>
                  {market.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
