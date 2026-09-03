import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  trend?: {
    value: number;
    label: string;
  };
  className?: string;
  'data-testid'?: string;
}

export function StatCard({ label, value, icon: Icon, trend, className, 'data-testid': dataTestId }: StatCardProps) {
  return (
    <div className={cn("p-4 border border-card-border bg-card rounded-md", className)} data-testid={dataTestId}>
      <div className="flex items-start justify-between mb-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </div>
        {Icon && (
          <Icon className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <div className="text-2xl font-bold font-mono-tabular text-foreground">
        {value}
      </div>
      {trend && (
        <div className={cn(
          "text-xs font-medium mt-1",
          trend.value > 0 ? "text-chart-3" : trend.value < 0 ? "text-destructive" : "text-muted-foreground"
        )}>
          {trend.value > 0 ? '+' : ''}{trend.value}% {trend.label}
        </div>
      )}
    </div>
  );
}
