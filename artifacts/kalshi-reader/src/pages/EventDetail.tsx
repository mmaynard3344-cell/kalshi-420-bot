import { useParams } from 'wouter';
import { useGetEvent } from '@workspace/api-client-react';
import { Layout } from '@/components/Layout';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { MarketCard } from '@/components/MarketCard';
import { ArrowLeft, Calendar } from 'lucide-react';
import { Link } from 'wouter';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/utils';

export default function EventDetail() {
  const params = useParams();
  const eventTicker = params.eventTicker as string;

  const { data, isLoading, error } = useGetEvent(eventTicker);

  if (isLoading) {
    return (
      <Layout>
        <LoadingSpinner className="py-20" size="lg" />
      </Layout>
    );
  }

  if (error || !data) {
    return (
      <Layout>
        <div className="text-center py-20">
          <p className="text-destructive font-medium mb-2">Failed to load event</p>
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : 'Event not found'}
          </p>
          <Link href="/events" className="inline-block mt-4 text-primary hover:underline">
            Back to Events
          </Link>
        </div>
      </Layout>
    );
  }

  const { event, markets } = data;

  return (
    <Layout>
      <div className="space-y-6">
        {/* Back Link */}
        <Link
          href="/events"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="link-back-events"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Events
        </Link>

        {/* Event Header */}
        <div className="border border-card-border bg-card rounded-lg p-6">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex-1">
              <h1 className="text-2xl font-bold text-foreground mb-2" data-testid="event-title">
                {event.title}
              </h1>
              {event.sub_title && (
                <p className="text-muted-foreground mb-3" data-testid="event-subtitle">
                  {event.sub_title}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span className="font-mono-tabular">{event.event_ticker}</span>
                {event.series_ticker && (
                  <>
                    <span className="text-border">•</span>
                    <span className="font-mono-tabular">{event.series_ticker}</span>
                  </>
                )}
                {event.category && (
                  <>
                    <span className="text-border">•</span>
                    <span>{event.category}</span>
                  </>
                )}
              </div>
            </div>
            <span className={cn(
              "px-3 py-1.5 text-sm font-medium rounded uppercase shrink-0",
              event.status === 'open' && "bg-chart-3/10 text-chart-3",
              event.status === 'closed' && "bg-muted text-muted-foreground",
              event.status === 'settled' && "bg-primary/10 text-primary"
            )} data-testid="event-status">
              {event.status}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-4 pt-4 border-t border-card-border">
            {event.strike_date && (
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Strike Date:</span>
                <span className="font-medium text-foreground" data-testid="strike-date">
                  {formatDate(event.strike_date)}
                </span>
              </div>
            )}
            {event.mutually_exclusive && (
              <div className="flex items-center gap-2 text-sm">
                <div className="h-2 w-2 rounded-full bg-primary" />
                <span className="font-medium text-primary">Mutually Exclusive</span>
              </div>
            )}
          </div>
        </div>

        {/* Markets */}
        <div>
          <h2 className="text-xl font-bold text-foreground mb-4">
            Markets {markets && markets.length > 0 && (
              <span className="text-muted-foreground font-normal">({markets.length})</span>
            )}
          </h2>
          {markets && markets.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {markets.map((market) => (
                <MarketCard key={market.ticker} market={market} />
              ))}
            </div>
          ) : (
            <div className="text-center py-12 border border-card-border rounded-lg text-muted-foreground">
              No markets found for this event
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
