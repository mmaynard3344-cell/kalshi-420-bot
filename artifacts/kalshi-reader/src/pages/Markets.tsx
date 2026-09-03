import { useState } from 'react';
import { useListMarkets } from '@workspace/api-client-react';
import { Layout } from '@/components/Layout';
import { MarketTable } from '@/components/MarketTable';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Search, Filter } from 'lucide-react';

export default function Markets() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [limit] = useState(100);

  const { data, isLoading, error } = useListMarkets({
    limit,
    status: statusFilter === 'all' ? undefined : statusFilter,
  });

  const filteredMarkets = data?.markets.filter((market) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      market.title.toLowerCase().includes(query) ||
      market.ticker.toLowerCase().includes(query) ||
      market.subtitle?.toLowerCase().includes(query)
    );
  }) || [];

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2">All Markets</h1>
          <p className="text-muted-foreground">
            Browse and filter prediction markets
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search markets by title or ticker..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search-markets"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]" data-testid="select-status-filter">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="settled">Settled</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Loading State */}
        {isLoading && (
          <LoadingSpinner className="py-20" size="lg" />
        )}

        {/* Error State */}
        {error && !isLoading && (
          <div className="text-center py-20">
            <p className="text-destructive font-medium mb-2">Failed to load markets</p>
            <p className="text-sm text-muted-foreground">
              {error instanceof Error ? error.message : 'Unknown error occurred'}
            </p>
          </div>
        )}

        {/* Markets Table */}
        {!isLoading && !error && data && (
          <>
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Showing {filteredMarkets.length} of {data.markets.length} markets
              </p>
            </div>
            <MarketTable markets={filteredMarkets} />
          </>
        )}
      </div>
    </Layout>
  );
}
