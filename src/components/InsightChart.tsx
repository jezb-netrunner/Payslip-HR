// A report chart (src/lib/insights.ts Chart) drawn with recharts to the
// dataviz specs: thin bars (<= 24px) with 4px rounded data ends, a 2px
// white gap between stacked segments, solid hairline grid, a legend for two
// or more series, values leading in the tooltip — and a table view of the
// same numbers one click away (colour is never the only way to read it).

import { useState } from 'react'
import { BarChart3, Table2 } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, LabelList, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Chart, ChartUnit } from '../lib/insights'
import { fmtNum, money } from '../lib/format'
import { Card } from './ui'

/** Categorical slots in fixed order (validated with the dataviz script; see MEMORY.md). */
export const CHART_SERIES = ['#3a8a5c', '#1d6fb1', '#eda100', '#6250d6', '#d9661a']
const GRID = '#e6e6ed'
const BASELINE = '#cfcfd8'
const MUTED = '#767888'
const INK = '#41434f'

export function formatValue(v: number, unit: ChartUnit): string {
  switch (unit) {
    case 'money':
      return money(v)
    case 'hours':
      return `${fmtNum(v)} h`
    case 'percent':
      return `${fmtNum(v)}%`
    case 'days':
      return `${fmtNum(v)} ${v === 1 ? 'day' : 'days'}`
    default:
      return fmtNum(v)
  }
}

/** Axis ticks: compact from 1,000 up (₱12K, 1.5K h). */
function tick(v: number, unit: ChartUnit): string {
  const abs = Math.abs(v)
  const short = abs >= 1e6 ? `${fmtNum(Math.round(v / 1e5) / 10)}M` : abs >= 1000 ? `${fmtNum(Math.round(v / 100) / 10)}K` : fmtNum(v)
  return unit === 'money' ? `₱${short}` : unit === 'percent' ? `${short}%` : short
}

interface TooltipPayload {
  dataKey?: string | number
  name?: string | number
  value?: number | string
  color?: string
}

function ChartTooltip({ active, payload, label, unit }: { active?: boolean; payload?: readonly TooltipPayload[]; label?: string | number; unit: ChartUnit }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-semibold text-slate-500">{label}</p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: p.color }} aria-hidden />
          <span className="font-bold text-ink-900">{formatValue(Number(p.value ?? 0), unit)}</span>
          <span className="text-slate-500">{p.name}</span>
        </p>
      ))}
    </div>
  )
}

export function InsightChart({ chart }: { chart: Chart }) {
  const [asTable, setAsTable] = useState(false)
  const data = chart.categories.map((c, i) => {
    const row: Record<string, string | number> = { category: c }
    for (const s of chart.series) row[s.key] = s.values[i] ?? 0
    return row
  })
  const many = chart.series.length > 1
  const horizontal = chart.kind === 'bars'
  const height = horizontal ? Math.max(120, chart.categories.length * 34 + 24) : 260

  return (
    <Card
      title={chart.title}
      actions={
        <button
          type="button"
          onClick={() => setAsTable(!asTable)}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-ink-900"
          aria-pressed={asTable}
        >
          {asTable ? <BarChart3 className="size-3.5" /> : <Table2 className="size-3.5" />}
          {asTable ? 'Chart' : 'Table'}
        </button>
      }
    >
      {asTable ? (
        <div className="scroll-thin overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-1.5 pr-4 font-semibold"> </th>
                {chart.series.map((s) => (
                  <th key={s.key} className="py-1.5 pr-4 text-right font-semibold">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {chart.categories.map((c, i) => (
                <tr key={c}>
                  <td className="py-1.5 pr-4 text-slate-700">{c}</td>
                  {chart.series.map((s) => (
                    <td key={s.key} className="py-1.5 pr-4 text-right tabular-nums text-ink-900">{formatValue(s.values[i] ?? 0, chart.unit)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ height }} role="img" aria-label={`${chart.title}. The Table button shows the figures.`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout={horizontal ? 'vertical' : 'horizontal'}
              barCategoryGap={horizontal ? '24%' : '30%'}
              barGap={2}
              margin={horizontal ? { top: 0, right: 96, bottom: 0, left: 0 } : { top: 8, right: 8, bottom: 0, left: 0 }}
            >
              {/* ranked bars carry their values at the tips: no grid to read them against */}
              {!horizontal && <CartesianGrid vertical={false} stroke={GRID} />}
              {horizontal ? (
                <>
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="category"
                    width={150}
                    tick={{ fontSize: 11, fill: INK }}
                    tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)}
                    axisLine={{ stroke: BASELINE }}
                    tickLine={false}
                  />
                </>
              ) : (
                <>
                  <XAxis dataKey="category" tick={{ fontSize: 11, fill: MUTED }} axisLine={{ stroke: BASELINE }} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 11, fill: MUTED }}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                    allowDecimals={chart.unit !== 'count' && chart.unit !== 'days'}
                    tickFormatter={(v: number) => tick(v, chart.unit)}
                  />
                </>
              )}
              <Tooltip
                cursor={{ fill: 'rgba(29, 27, 37, 0.04)' }}
                content={(p) => <ChartTooltip active={p.active} payload={p.payload as unknown as readonly TooltipPayload[]} label={p.label} unit={chart.unit} />}
              />
              {many && (
                <Legend
                  // the series' own order (the stack's, bottom to top), not alphabetical
                  itemSorter={null}
                  iconType="square"
                  iconSize={10}
                  wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
                  formatter={(value) => <span style={{ color: INK }}>{value}</span>}
                />
              )}
              {chart.series.map((s, i) => {
                const last = i === chart.series.length - 1
                // the data end is rounded: the top of a stack, or every bar when grouped
                const rounded = !chart.stacked || last
                return (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    fill={CHART_SERIES[i % CHART_SERIES.length]}
                    stackId={chart.stacked ? 'stack' : undefined}
                    stroke={chart.stacked ? '#ffffff' : undefined}
                    strokeWidth={chart.stacked ? 2 : 0}
                    maxBarSize={24}
                    radius={rounded ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0}
                    isAnimationActive={false}
                  >
                    {horizontal && !many && (
                      <LabelList dataKey={s.key} position="right" style={{ fontSize: 11, fill: INK }} formatter={(v: unknown) => formatValue(Number(v ?? 0), chart.unit)} />
                    )}
                  </Bar>
                )
              })}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}
