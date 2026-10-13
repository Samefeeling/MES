/**
 * The rules Crew orders works by, where the supervisor can see and change
 * them — see `domain/crewRules`.
 *
 * Changing one is planning, like changing a crew: it applies on this screen
 * at once (the next Crew orders uses it, and the board redraws the boxes of
 * orders nobody is on) and reaches every other screen when the plan is saved.
 * Read-only until the supervisor password is in.
 */

import { useEffect, useState } from 'react';
import type { LineDef, LineKey } from '@/domain/assembly';
import {
  DEFAULT_CREW_RULES,
  MAX_RULE_CREW,
  cleanBands,
  cleanPrefixes,
  type CrewRules,
  type CrewSizeBand,
} from '@/domain/crewRules';
import type { CrewSkipReason } from '@/engine/assembly/crew';
import { usePlanStore } from '@/store/planStore';
import { useSupervisorStore } from '@/store/supervisorStore';

const hoursText = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)} h`;

/** The rules in a line, for the panel and the button's hover. */
export function describeCrewRules(rules: CrewRules, lineName: (key: LineKey) => string): string {
  const parts: string[] = [];
  if (rules.skipPrefixes.length) parts.push(`never ${rules.skipPrefixes.map((p) => `${p}…`).join(', ')}`);
  if (rules.releasedOnly) parts.push('released only');
  if (rules.horizonDays != null) parts.push(`due within ${rules.horizonDays} d`);
  parts.push(`due bands ${rules.dueTiersDays.join(' / ')} d`);
  let from = 0;
  const sizes = rules.sizeBands.map((band) => {
    const text = band.upToHours == null ? `${band.crew} over ${hoursText(from)}` : `${band.crew} up to ${hoursText(band.upToHours)}`;
    if (band.upToHours != null) from = band.upToHours;
    return text;
  });
  parts.push(`team ${sizes.join(', ')}`);
  for (const [key, rule] of Object.entries(rules.lines)) {
    if (!rule.auto) parts.push(`${lineName(key as LineKey)} by hand`);
    else if (rule.crew != null) parts.push(`${lineName(key as LineKey)} ${rule.crew}`);
  }
  if (rules.requireTrade) parts.push('trade must match');
  return parts.join(' · ');
}

/** What each skip reason reads as beside an order. */
export function skipLabel(reason: CrewSkipReason, rules: CrewRules): string {
  switch (reason) {
    case 'prefix':
      return 'never crewed (prefix)';
    case 'unreleased':
      return 'not released';
    case 'line':
      return 'line crewed by hand';
    case 'horizon':
      return rules.horizonDays == null ? 'no Due Date' : `due beyond ${rules.horizonDays} d`;
  }
}

/** A text box that commits on Enter or leaving it, so commas can be typed. */
function Draft({
  value,
  onCommit,
  label,
  placeholder,
  disabled,
  width,
}: {
  value: string;
  onCommit: (text: string) => void;
  label: string;
  placeholder?: string;
  disabled: boolean;
  width: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label={label}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      style={{ width }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(value);
      }}
    />
  );
}

const numbers = (text: string): number[] =>
  text
    .split(/[\s,/;]+/)
    .map((t) => Number(t))
    .filter((n) => Number.isFinite(n));

export function CrewRulesEditor({ lines }: { lines: LineDef[] }) {
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const rules = usePlanStore((s) => s.crewRules);
  const setRules = usePlanStore((s) => s.setCrewRules);
  const change = (patch: Partial<CrewRules>) => setRules({ ...rules, ...patch });
  const off = !unlocked;

  const setBand = (i: number, patch: Partial<CrewSizeBand>) =>
    change({ sizeBands: cleanBands(rules.sizeBands.map((b, j) => (j === i ? { ...b, ...patch } : b))) });
  const bounded = rules.sizeBands.filter((b) => b.upToHours != null);
  const open = rules.sizeBands[rules.sizeBands.length - 1];

  return (
    <div className="crew-rules">
      <div className="crew-rules-row">
        <span>Never crew orders starting</span>
        <Draft
          label="Order number prefixes never crewed"
          value={rules.skipPrefixes.join(', ')}
          placeholder="none"
          disabled={off}
          width="12em"
          onCommit={(text) => change({ skipPrefixes: cleanPrefixes(text.split(/[\s,;]+/)) })}
        />
      </div>
      <label className="crew-rules-row">
        <input
          type="checkbox"
          checked={rules.releasedOnly}
          disabled={off}
          onChange={(e) => change({ releasedOnly: e.target.checked })}
        />
        <span>Released orders only</span>
      </label>
      <label className="crew-rules-row">
        <input
          type="checkbox"
          checked={rules.requireTrade}
          disabled={off}
          onChange={(e) => change({ requireTrade: e.target.checked })}
        />
        <span>Trade must match the bench (a cutter is not put on gluing)</span>
      </label>
      <div className="crew-rules-row">
        <span>Only orders due within</span>
        <Draft
          label="Due horizon in days"
          value={rules.horizonDays == null ? '' : String(rules.horizonDays)}
          placeholder="any"
          disabled={off}
          width="4em"
          onCommit={(text) => {
            const n = numbers(text)[0];
            change({ horizonDays: n != null && n > 0 ? Math.round(n) : null });
          }}
        />
        <span>days</span>
      </div>
      <div className="crew-rules-row">
        <span>Due bands, crewed in turn</span>
        <Draft
          label="Due-date bands in days"
          value={rules.dueTiersDays.join(', ')}
          disabled={off}
          width="8em"
          onCommit={(text) => {
            const tiers = [...new Set(numbers(text).filter((n) => n > 0).map(Math.round))].sort((a, b) => a - b);
            change({ dueTiersDays: tiers.length ? tiers : DEFAULT_CREW_RULES.dueTiersDays });
          }}
        />
        <span>days</span>
      </div>

      <table className="crew-rules-table">
        <thead>
          <tr><th>Remaining hours</th><th>Team</th>{unlocked && <th />}</tr>
        </thead>
        <tbody>
          {bounded.map((band, i) => (
            <tr key={`b${i}`}>
              <td>
                up to{' '}
                <Draft
                  label="Up to hours"
                  value={String(band.upToHours)}
                  disabled={off}
                  width="4em"
                  onCommit={(text) => {
                    const n = numbers(text)[0];
                    if (n != null && n > 0) setBand(i, { upToHours: n });
                  }}
                />{' '}
                h
              </td>
              <td>
                <select value={band.crew} disabled={off} aria-label="Team size" onChange={(e) => setBand(i, { crew: Number(e.target.value) })}>
                  {Array.from({ length: MAX_RULE_CREW }, (_, n) => <option key={n} value={n + 1}>{n + 1}</option>)}
                </select>
              </td>
              {unlocked && (
                <td>
                  <button
                    aria-label="Remove band"
                    title="Remove this band"
                    onClick={() => change({ sizeBands: cleanBands(rules.sizeBands.filter((_, j) => j !== i)) })}
                  >
                    ×
                  </button>
                </td>
              )}
            </tr>
          ))}
          <tr>
            <td>more than that</td>
            <td>
              <select
                value={open.crew}
                disabled={off}
                aria-label="Team size for the largest orders"
                onChange={(e) => setBand(rules.sizeBands.length - 1, { crew: Number(e.target.value) })}
              >
                {Array.from({ length: MAX_RULE_CREW }, (_, n) => <option key={n} value={n + 1}>{n + 1}</option>)}
              </select>
            </td>
            {unlocked && (
              <td>
                <button
                  title="Add a band above the largest"
                  onClick={() => {
                    const top = bounded[bounded.length - 1]?.upToHours ?? 0;
                    change({ sizeBands: cleanBands([...rules.sizeBands, { upToHours: top + 7.5, crew: open.crew }]) });
                  }}
                >
                  +
                </button>
              </td>
            )}
          </tr>
        </tbody>
      </table>

      <table className="crew-rules-table">
        <thead>
          <tr><th>Line</th><th>Crew orders</th><th>Fixed team</th></tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const rule = rules.lines[line.key] ?? { auto: true, crew: null };
            const setLine = (patch: Partial<typeof rule>) => {
              const next = { ...rule, ...patch };
              const { [line.key]: _old, ...rest } = rules.lines;
              change({ lines: next.auto && next.crew == null ? rest : { ...rest, [line.key]: next } });
            };
            return (
              <tr key={line.key}>
                <td>{line.name}</td>
                <td>
                  <select
                    value={rule.auto ? 'auto' : 'hand'}
                    disabled={off}
                    aria-label={`How ${line.name} is crewed`}
                    onChange={(e) => setLine({ auto: e.target.value === 'auto' })}
                  >
                    <option value="auto">Automatically</option>
                    <option value="hand">By hand only</option>
                  </select>
                </td>
                <td>
                  <select
                    value={rule.crew ?? ''}
                    disabled={off || !rule.auto}
                    aria-label={`Fixed team on ${line.name}`}
                    onChange={(e) => setLine({ crew: e.target.value ? Number(e.target.value) : null })}
                  >
                    <option value="">By hours</option>
                    {Array.from({ length: MAX_RULE_CREW }, (_, n) => <option key={n} value={n + 1}>{n + 1}</option>)}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {unlocked ? (
        <div className="crew-rules-actions">
          <span>Applies here at once; Save to share it with every screen.</span>
          <button onClick={() => setRules(DEFAULT_CREW_RULES)} title="Back to the rules the board started with">
            Reset
          </button>
        </div>
      ) : (
        <p className="metric-note">Sign in as supervisor to change the rules.</p>
      )}
    </div>
  );
}
