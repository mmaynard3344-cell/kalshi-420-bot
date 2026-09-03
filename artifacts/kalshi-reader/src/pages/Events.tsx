import { useState } from 'react';
import { useListEvents } from '@workspace/api-client-react';
import { Layout } from '@/components/Layout';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Link } from 'wouter';
import { Input } from '@/components/ui/input';
import { Search, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/utils';

export default function Events() {
  const [searchQuery, setSearchQuery] = useState('');
  const [limit] = useState(100);

  const { data, isLoading, error } = useListEvents({ limit });

  const filteredEvents = data?.events.filter((event) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      event.title.toLowerCase().includes(query) ||
      event.event_ticker.toLowerCase().includes(query) ||
      event.sub_title?.toLowerCase().includes(query)
    );
  }) || [];

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2">Events</h1>
          <p className="text-muted-foreground">
            Browse prediction events and their markets
          </p>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search events by title or ticker..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-events"
          />
        </div>

        {/* Loading State */}
        {isLoading && (
          <LoadingSpinner className="py-20" size="lg" />
        )}

        {/* Error State */}
        {error && !isLoading && (
          <div className="text-center py-20">
            <p className="text-destructive font-medium mb-2">Failed to load events</p>
            <p className="text-sm text-muted-foreground">
              {error instanceof Error ? error.message : 'Unknown error occurred'}
            </p>
          </div>
        )}

        {/* Events List */}
        {!isLoading && !error && data && (
          <>
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Showing {filteredEvents.length} of {data.events.length} events
              </p>
            </div>
            <div className="space-y-3">
              {filteredEvents.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  No events found
                </div>
              ) : (
                filteredEvents.map((event) => (
                  <Link
                    key={event.event_ticker}
                    href={`/events/${event.event_ticker}`}
                    className="block p-4 border border-card-border bg-card rounded-md hover:border-primary/50 transition-all hover:shadow-sm group"
                    data-testid={`card-event-${event.event_ticker}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-3 mb-2">
                          <h3 className="font-semibold text-base text-foreground leading-tight flex-1" data-testid={`title-${event.event_ticker}`}>
                            {event.title}
                          </h3>
                          <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                        </div>
                        {event.sub_title && (
                          <p className="text-sm text-muted-foreground mb-2">
                            {event.sub_title}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span className="font-mono-tabular">{event.event_ticker}</span>
                          {event.category && (
                            <>
                              <span className="text-border">•</span>
                              <span>{event.category}</span>
                            </>
                          )}
                          {event.strike_date && (
                            <>
                              <span className="text-border">•</span>
                              <span>{formatDate(event.strike_date)}</span>
                            </>
                          )}
                          {event.mutually_exclusive && (
                            <>
                              <span className="text-border">•</span>
                              <span className="text-primary">Mutually Exclusive</span>
                            </>
                          )}
                        </div>
                      </div>
                      <span className={cn(
                        "px-2 py-0.5 text-xs font-medium rounded uppercase shrink-0",
                        event.status === 'open' && "bg-chart-3/10 text-chart-3",
                        event.status === 'closed' && "bg-muted text-muted-foreground",
                        event.status === 'settled' && "bg-primary/10 text-primary"
                      )} data-testid={`status-${event.event_ticker}`}>
                        {event.status}
                      </span>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
