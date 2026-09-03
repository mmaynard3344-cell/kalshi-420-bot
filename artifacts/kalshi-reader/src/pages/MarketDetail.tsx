import { useParams } from 'wouter';
import { useGetMarket, useGetMarketOrderbook } from '@workspace/api-client-react';
import { Layout } from '@/components/Layout';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { formatPrice, formatVolume, formatDateTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { ArrowLeft, TrendingUp, Activity } from 'lucide-react';
import { Link } from 'wouter';

export default function MarketDetail() {
  const params = useParams();
  const ticker = params.ticker as string;

  const { data: market, isLoading: marketLoading, error: marketError } = useGetMarket(ticker);
  const { data: orderbook, isLoading: orderbookLoading } = useGetMarketOrderbook(ticker);

  const isLoading = marketLoading || orderbookLoading;

  if (isLoading) {
    return (
      <Layout>
        <LoadingSpinner className="py-20" size="lg" />
      </Layout>
    );
  }

  if (marketError || !market) {
    return (
      <Layout>
        <div className="text-center py-20">
          <p className="text-destructive font-medium mb-2">Failed to load market</p>
          <p className="text-sm text-muted-foreground">
            {marketError instanceof Error ? marketError.message : 'Market not found'}
          </p>
          <Link href="/markets" className="inline-block mt-4 text-primary hover:underline">
            Back to Markets
          </Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        {/* Back Link */}
        <Link
          href="/markets"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="link-back-markets"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Markets
        </Link>

        {/* Market Header */}
        <div className="border border-card-border bg-card rounded-lg p-6">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex-1">
              <h1 className="text-2xl font-bold text-foreground mb-2" data-testid="market-title">
                {market.title}
              </h1>
              {market.subtitle && (
                <p className="text-muted-foreground" data-testid="market-subtitle">
                  {market.subtitle}
                </p>
              )}
              <div className="flex items-center gap-3 mt-3 text-sm text-muted-foreground">
                <span className="font-mono-tabular">{market.ticker}</span>
                {market.category && (
                  <>
                    <span className="text-border">•</span>
                    <span>{market.category}</span>
                  </>
                )}
              </div>
            </div>
            <span className={cn(
              "px-3 py-1.5 text-sm font-medium rounded uppercase shrink-0",
              market.status === 'open' && "bg-chart-3/10 text-chart-3",
              market.status === 'closed' && "bg-muted text-muted-foreground",
              market.status === 'settled' && "bg-primary/10 text-primary"
            )} data-testid="market-status">
              {market.status}
            </span>
          </div>
        </div>

        {/* Price Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Yes Prices */}
          <div className="border border-primary/20 bg-card rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-2 w-2 rounded-full bg-primary" />
              <h2 className="text-lg font-bold text-foreground">Yes</h2>
            </div>
            <div className="space-y-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Bid Price</div>
                <div className="text-3xl font-mono-tabular font-bold text-primary" data-testid="yes-bid-price">
                  {formatPrice(market.yes_bid)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Ask Price</div>
                <div className="text-xl font-mono-tabular font-semibold text-primary/60" data-testid="yes-ask-price">
                  {formatPrice(market.yes_ask)}
                </div>
              </div>
            </div>
          </div>

          {/* No Prices */}
          <div className="border border-accent/20 bg-card rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-2 w-2 rounded-full bg-accent" />
              <h2 className="text-lg font-bold text-foreground">No</h2>
            </div>
            <div className="space-y-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Bid Price</div>
                <div className="text-3xl font-mono-tabular font-bold text-accent" data-testid="no-bid-price">
                  {formatPrice(market.no_bid)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Ask Price</div>
                <div className="text-xl font-mono-tabular font-semibold text-accent/60" data-testid="no-ask-price">
                  {formatPrice(market.no_ask)}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Market Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="border border-card-border bg-card rounded-lg p-4">
            <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Last Price</div>
            <div className="text-xl font-mono-tabular font-bold text-foreground" data-testid="last-price">
              {formatPrice(market.last_price)}
            </div>
          </div>
          <div className="border border-card-border bg-card rounded-lg p-4">
            <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">24h Volume</div>
            <div className="text-xl font-mono-tabular font-bold text-foreground" data-testid="volume-24h">
              {formatVolume(market.volume_24h)}
            </div>
          </div>
          <div className="border border-card-border bg-card rounded-lg p-4">
            <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Open Interest</div>
            <div className="text-xl font-mono-tabular font-bold text-foreground" data-testid="open-interest">
              {formatVolume(market.open_interest)}
            </div>
          </div>
          <div className="border border-card-border bg-card rounded-lg p-4">
            <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Liquidity</div>
            <div className="text-xl font-mono-tabular font-bold text-foreground" data-testid="liquidity">
              {formatVolume(market.liquidity)}
            </div>
          </div>
        </div>

        {/* Orderbook */}
        {orderbook && (orderbook.yes?.length || orderbook.no?.length) && (
          <div className="border border-card-border bg-card rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-bold text-foreground">Order Book</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Yes Orders */}
              <div>
                <h3 className="text-sm font-semibold text-primary mb-3">Yes Orders</h3>
                <div className="space-y-2">
                  {orderbook.yes && orderbook.yes.length > 0 ? (
                    orderbook.yes.slice(0, 10).map((order, idx) => (
                      <div key={idx} className="flex items-center justify-between text-sm">
                        <span className="font-mono-tabular text-primary font-medium">
                          {formatPrice(order.price)}
                        </span>
                        <span className="font-mono-tabular text-muted-foreground">
                          {order.quantity.toLocaleString()}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground">No orders</div>
                  )}
                </div>
              </div>

              {/* No Orders */}
              <div>
                <h3 className="text-sm font-semibold text-accent mb-3">No Orders</h3>
                <div className="space-y-2">
                  {orderbook.no && orderbook.no.length > 0 ? (
                    orderbook.no.slice(0, 10).map((order, idx) => (
                      <div key={idx} className="flex items-center justify-between text-sm">
                        <span className="font-mono-tabular text-accent font-medium">
                          {formatPrice(order.price)}
                        </span>
                        <span className="font-mono-tabular text-muted-foreground">
                          {order.quantity.toLocaleString()}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground">No orders</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Market Details */}
        <div className="border border-card-border bg-card rounded-lg p-6">
          <h2 className="text-lg font-bold text-foreground mb-4">Market Details</h2>
          <div className="space-y-4">
            {market.close_time && (
              <div>
                <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Close Time</div>
                <div className="text-sm font-medium text-foreground" data-testid="close-time">
                  {formatDateTime(market.close_time)}
                </div>
              </div>
            )}
            {market.expiration_time && (
              <div>
                <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Expiration Time</div>
                <div className="text-sm font-medium text-foreground" data-testid="expiration-time">
                  {formatDateTime(market.expiration_time)}
                </div>
              </div>
            )}
            {market.rules_primary && (
              <div>
                <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Rules</div>
                <div className="text-sm text-foreground leading-relaxed" data-testid="rules-primary">
                  {market.rules_primary}
                </div>
              </div>
            )}
            {market.rules_secondary && (
              <div>
                <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Additional Rules</div>
                <div className="text-sm text-foreground leading-relaxed" data-testid="rules-secondary">
                  {market.rules_secondary}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
