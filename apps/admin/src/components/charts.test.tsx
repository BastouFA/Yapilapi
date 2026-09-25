import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderAsStaff } from '@/test-utils';
import { HBarChart, Kpi, LineChart, StackedBarChart } from './charts';

describe('charts are never the only way to read the numbers', () => {
  it('bar chart: titled figure, plain-language summary and a table with the same values', () => {
    renderAsStaff(
      <HBarChart
        title="Cases by risk"
        summary="5 open, 2 critical."
        valueHeader="Cases"
        data={[
          { label: 'Critical', value: 2 },
          { label: 'High', value: 3 },
        ]}
      />,
    );
    const fig = screen.getByRole('figure', { name: 'Cases by risk' });
    expect(fig).toHaveAccessibleDescription('5 open, 2 critical.');
    const table = within(fig).getByRole('table', { name: 'Cases by risk', hidden: true });
    expect(
      within(table).getByRole('row', { name: /Critical\s*2/, hidden: true }),
    ).toBeInTheDocument();
  });

  it('shows suppressed values as text, not as zero-length bars', () => {
    renderAsStaff(
      <HBarChart
        title="Reports"
        summary="s"
        data={[
          { label: 'Spam', value: null },
          { label: 'Scam', value: 9 },
        ]}
      />,
    );
    expect(screen.getAllByText('Hidden (fewer than 5)').length).toBeGreaterThan(0);
  });

  it('line chart: gaps for suppressed points and a table alternative', () => {
    renderAsStaff(
      <LineChart
        title="Sign-ups"
        summary="3 days"
        valueHeader="Sign-ups"
        points={[
          { x: '2026-09-19', y: 6 },
          { x: '2026-09-20', y: null },
          { x: '2026-09-21', y: 8 },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Sign-ups', hidden: true });
    expect(within(table).getAllByText('Hidden (fewer than 5)', { exact: true }).length).toBe(1);
  });

  it('shows an honest empty state instead of an empty plot', () => {
    renderAsStaff(
      <StackedBarChart
        title="Actions"
        summary="none"
        groups={[]}
        series={[{ label: 'Posts', slot: 1 }]}
      />,
    );
    expect(screen.getByText('No data for this period.')).toBeInTheDocument();
  });

  it('draws only with CSS classes (no inline styles, so the strict CSP holds)', () => {
    const { container } = renderAsStaff(
      <>
        <HBarChart title="a" summary="s" data={[{ label: 'x', value: 1 }]} />
        <LineChart
          title="b"
          summary="s"
          valueHeader="v"
          points={[
            { x: '1', y: 1 },
            { x: '2', y: 2 },
          ]}
        />
        <Kpi label="k" value="1" />
      </>,
    );
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });
});
