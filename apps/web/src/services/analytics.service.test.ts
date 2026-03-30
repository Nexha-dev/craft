import { beforeEach, describe, expect, it, vi } from 'vitest';

type AnalyticsRow = {
  id: string;
  deployment_id: string;
  metric_type: string;
  metric_value: number;
  recorded_at: string;
};

const state = {
  rows: [] as AnalyticsRow[],
  seq: 0,
};

const nextTimestamp = () => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  return new Date(base + state.seq * 1000).toISOString();
};

const makeQuery = () => {
  const filters: Array<(row: AnalyticsRow) => boolean> = [];
  let sort: { column: string; ascending: boolean } | null = null;

  const q: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn((column: string, value: string | number) => {
      filters.push((row) => (row as any)[column] === value);
      return q;
    }),
    gte: vi.fn((column: string, value: string) => {
      filters.push((row) => (row as any)[column] >= value);
      return q;
    }),
    lte: vi.fn((column: string, value: string) => {
      filters.push((row) => (row as any)[column] <= value);
      return q;
    }),
    order: vi.fn((column: string, opts?: { ascending?: boolean }) => {
      sort = { column, ascending: opts?.ascending ?? true };
      return q;
    }),
    then: (resolve: any, reject: any) => {
      const data = state.rows
        .filter((row) => filters.every((predicate) => predicate(row)))
        .slice()
        .sort((a, b) => {
          if (!sort) {
            return 0;
          }

          const left = (a as any)[sort.column];
          const right = (b as any)[sort.column];
          if (left === right) {
            return 0;
          }

          const result = left < right ? -1 : 1;
          return sort.ascending ? result : -result;
        });

      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };

  return q;
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== 'deployment_analytics') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        insert: async (payload: {
          deployment_id: string;
          metric_type: string;
          metric_value: number;
        }) => {
          state.seq += 1;
          const row: AnalyticsRow = {
            id: `row-${state.seq}`,
            deployment_id: payload.deployment_id,
            metric_type: payload.metric_type,
            metric_value: payload.metric_value,
            recorded_at: nextTimestamp(),
          };
          state.rows.push(row);
          return { data: [row], error: null };
        },
        ...makeQuery(),
      };
    },
  }),
}));

describe('AnalyticsService integration flow', () => {
  beforeEach(() => {
    state.rows = [];
    state.seq = 0;
    vi.clearAllMocks();
  });

  it('records and retrieves page view analytics for a deployment', async () => {
    const { AnalyticsService } = await import('./analytics.service');
    const service = new AnalyticsService();

    await service.recordPageView('dep-1');
    await service.recordPageView('dep-1');
    await service.recordPageView('dep-2');

    const analytics = await service.getAnalytics('dep-1', 'page_view');

    expect(analytics).toHaveLength(2);
    expect(analytics.every((row) => row.metricType === 'page_view')).toBe(true);
    expect(analytics.every((row) => row.metricValue === 1)).toBe(true);
  });

  it('calculates analytics summary totals and uptime percentage', async () => {
    const { AnalyticsService } = await import('./analytics.service');
    const service = new AnalyticsService();

    await service.recordPageView('dep-1');
    await service.recordPageView('dep-1');
    await service.recordPageView('dep-1');
    await service.recordUptimeCheck('dep-1', true);
    await service.recordUptimeCheck('dep-1', false);
    await service.recordUptimeCheck('dep-1', true);
    await service.recordTransactionCount('dep-1', 2);
    await service.recordTransactionCount('dep-1', 5);

    const summary = await service.getAnalyticsSummary('dep-1');

    expect(summary.totalPageViews).toBe(3);
    expect(summary.uptimePercentage).toBe(66.67);
    expect(summary.totalTransactions).toBe(7);
    expect(summary.lastChecked).toBeInstanceOf(Date);
  });

  it('persists analytics data across sequential read and write operations', async () => {
    const { AnalyticsService } = await import('./analytics.service');
    const service = new AnalyticsService();

    await service.recordPageView('dep-1');
    const firstRead = await service.getAnalytics('dep-1');
    expect(firstRead).toHaveLength(1);

    await service.recordTransactionCount('dep-1', 4);
    const secondRead = await service.getAnalytics('dep-1');
    expect(secondRead).toHaveLength(2);

    const csv = await service.exportAnalytics('dep-1');
    const lines = csv.split('\n');

    expect(lines[0]).toBe('Metric Type,Value,Recorded At');
    expect(lines).toHaveLength(3);
  });
});
