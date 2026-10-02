/**
 * The days the factory is shut on a weekday, under Crew capacity: the NSW
 * public holidays the board works out for itself, and the days held in the
 * SharePoint list `FactoryCalendar` — the RDOs, and any holiday typed in by
 * hand (a row's Name says which: "RDO", or the holiday's name).
 *
 * Both carry no capacity and take no work — the schedule steps over them the
 * way it steps over a weekend, the load strip and the banner read them as
 * closed, and level loading never puts an order on one. Dropping a bar on one
 * asks for overtime, like a weekend. A day added here is written to the list
 * at once, not held for Save: every screen reads the list on its next refresh.
 */

import { useState } from 'react';
import { closureKindOf, nswPublicHolidays } from '@/engine/assembly/factoryCalendar';
import { formatShortDay, fromDayKey } from '@/lib/time';
import { useCalendarStore } from '@/store/calendarStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { MetricNote } from './Metric';

const WEEKDAY = new Intl.DateTimeFormat('en-AU', { weekday: 'short' });
const dayText = (key: string) => {
  const d = fromDayKey(key);
  return `${WEEKDAY.format(d)} ${formatShortDay(d)}`;
};
const weekend = (key: string) => {
  const day = fromDayKey(key).getDay();
  return day === 0 || day === 6;
};

export function FactoryCalendar({ today }: { today: Date }) {
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const rows = useCalendarStore((s) => s.rows);
  const status = useCalendarStore((s) => s.status);
  const error = useCalendarStore((s) => s.error);
  const busy = useCalendarStore((s) => s.busy);
  const where = useCalendarStore((s) => s.backend.where);
  const addDay = useCalendarStore((s) => s.add);
  const removeDay = useCalendarStore((s) => s.remove);
  const [year, setYear] = useState(today.getFullYear());
  const [day, setDay] = useState('');
  const [name, setName] = useState('');

  const holidays = nswPublicHolidays(year);
  const holidayOn = new Map(holidays.map((h) => [h.day, h]));
  const listed = rows.filter((r) => r.day.startsWith(`${year}-`));
  const rdoCount = listed.filter((r) => closureKindOf(r.name) === 'rdo').length;
  const closedWeekdays = holidays.filter((h) => !weekend(h.day)).length;

  /** Why the day being entered would change nothing, if it would not. */
  const clash = !day
    ? null
    : weekend(day)
      ? 'a weekend — the factory is shut then anyway'
      : holidayOn.get(day)
        ? `${holidayOn.get(day)!.name} — already a public holiday`
        : rows.find((r) => r.day === day)
          ? `already in the list (${rows.find((r) => r.day === day)!.name})`
          : null;

  const add = async () => {
    if (!day || clash || busy) return;
    const saved = await addDay(day, name.trim() || 'RDO');
    if (!saved) return; // the error is shown; what was typed stays to retry
    // A run of RDOs is usually typed one after another: the year follows it.
    setYear(Number(day.slice(0, 4)));
    setDay('');
    setName('');
  };

  return (
    <div className="factory-calendar">
      <div className="fc-head">
        <h4>Closed days</h4>
        <span className="fc-year">
          <button type="button" onClick={() => setYear(year - 1)} aria-label="Previous year">◂</button>
          <b>{year}</b>
          <button type="button" onClick={() => setYear(year + 1)} aria-label="Next year">▸</button>
        </span>
      </div>
      <MetricNote>
        Weekends, NSW public holidays and the days in the FactoryCalendar list are shut: nothing is
        planned on them, they carry no capacity, and dropping work on one asks for overtime.
      </MetricNote>
      <div className="fc-lists">
        <section>
          <h5>NSW public holidays · {closedWeekdays} on weekdays</h5>
          <ul>
            {holidays.map((h) => (
              <li key={h.day} className={weekend(h.day) ? 'fc-weekend' : undefined}>
                <span className="fc-day">{dayText(h.day)}</span>
                <span>{h.name}</span>
              </li>
            ))}
          </ul>
          <MetricNote>
            Worked out from the Public Holidays Act 2010, days in lieu included, plus the Monday
            after a weekend Anzac Day. Bank Holiday is not a factory holiday; a one-off proclaimed
            holiday goes in the list under its own name.
          </MetricNote>
        </section>
        <section>
          <h5>
            FactoryCalendar list · {rdoCount} RDO{rdoCount === 1 ? '' : 's'}
            {listed.length > rdoCount ? ` + ${listed.length - rdoCount} other` : ''} in {year}
          </h5>
          {status === 'loading' && rows.length === 0 ? (
            <MetricNote>Reading the list…</MetricNote>
          ) : listed.length === 0 ? (
            <MetricNote>None in the list for {year}.</MetricNote>
          ) : (
            <ul>
              {listed.map((r) => (
                <li key={r.day} className={weekend(r.day) ? 'fc-weekend' : undefined}>
                  <span className="fc-day">{dayText(r.day)}</span>
                  <span className={`fc-kind ${closureKindOf(r.name)}`}>{r.name}</span>
                  {unlocked && (
                    <button
                      type="button"
                      className="fc-remove"
                      disabled={busy}
                      onClick={() => void removeDay(r.id)}
                      aria-label={`Remove ${r.name} on ${dayText(r.day)}`}
                      title="Remove from the list"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="fc-error" role="alert">{error}</p>}
          {unlocked ? (
            <form
              className="fc-add"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <input
                type="date"
                value={day}
                aria-label="Closed date"
                onChange={(e) => setDay(e.target.value)}
              />
              <input
                value={name}
                maxLength={60}
                placeholder="RDO, or holiday name"
                aria-label="Name"
                onChange={(e) => setName(e.target.value)}
              />
              <button type="submit" disabled={!day || Boolean(clash) || busy}>
                {busy ? 'Saving…' : 'Add to list'}
              </button>
              {clash && <span className="fc-clash">{dayText(day)} is {clash}.</span>}
            </form>
          ) : (
            <MetricNote>Sign in as supervisor to add or remove days.</MetricNote>
          )}
          <MetricNote>Kept in {where}.</MetricNote>
        </section>
      </div>
    </div>
  );
}
