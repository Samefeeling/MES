/**
 * The days the factory is shut on a weekday, under Crew capacity: the NSW
 * public holidays the board works out for itself, and the Rostered Days Off
 * the supervisor enters.
 *
 * Both carry no capacity and take no work — the schedule steps over them the
 * way it steps over a weekend, the load strip and the banner read them as
 * closed, and level loading never puts an order on one. Dropping a bar on one
 * asks for overtime, like a weekend. RDOs go out with the plan on Save, like
 * the crews: every screen has to schedule round the same days.
 */

import { useState } from 'react';
import { nswPublicHolidays } from '@/engine/assembly/factoryCalendar';
import { formatShortDay, fromDayKey } from '@/lib/time';
import { usePlanStore } from '@/store/planStore';
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
  const rdoDays = usePlanStore((s) => s.rdoDays);
  const setRdoDays = usePlanStore((s) => s.setRdoDays);
  const [year, setYear] = useState(today.getFullYear());
  const [day, setDay] = useState('');
  const [name, setName] = useState('');

  const holidays = nswPublicHolidays(year);
  const holidayOn = new Map(holidays.map((h) => [h.day, h]));
  const rdos = rdoDays.filter((r) => r.day.startsWith(`${year}-`));
  const closedWeekdays = holidays.filter((h) => !weekend(h.day)).length;

  /** Why the day being entered would change nothing, if it would not. */
  const clash = !day
    ? null
    : weekend(day)
      ? 'a weekend — the factory is shut then anyway'
      : holidayOn.get(day)
        ? `${holidayOn.get(day)!.name} — already a public holiday`
        : rdoDays.some((r) => r.day === day)
          ? 'already an RDO'
          : null;

  const add = () => {
    if (!day || clash) return;
    setRdoDays([...rdoDays, { day, name: name.trim() || undefined }]);
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
        Weekends, NSW public holidays and the factory’s RDOs are shut: nothing is planned on them,
        they carry no capacity, and dropping work on one asks for overtime.
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
            Worked out from the Public Holidays Act 2010, days in lieu included. Bank Holiday is
            not a factory holiday; a one-off proclaimed holiday is entered as an RDO.
          </MetricNote>
        </section>
        <section>
          <h5>RDOs · {rdos.length} in {year}</h5>
          {rdos.length === 0 ? (
            <MetricNote>None entered for {year}.</MetricNote>
          ) : (
            <ul>
              {rdos.map((r) => (
                <li key={r.day}>
                  <span className="fc-day">{dayText(r.day)}</span>
                  <span>{r.name ?? 'RDO'}</span>
                  {unlocked && (
                    <button
                      type="button"
                      className="fc-remove"
                      onClick={() => setRdoDays(rdoDays.filter((x) => x.day !== r.day))}
                      aria-label={`Remove the RDO on ${dayText(r.day)}`}
                      title="Remove"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {unlocked ? (
            <form
              className="fc-add"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <input
                type="date"
                value={day}
                aria-label="RDO date"
                onChange={(e) => setDay(e.target.value)}
              />
              <input
                value={name}
                maxLength={40}
                placeholder="Name (optional)"
                aria-label="RDO name"
                onChange={(e) => setName(e.target.value)}
              />
              <button type="submit" disabled={!day || Boolean(clash)}>Add RDO</button>
              {clash && <span className="fc-clash">{dayText(day)} is {clash}.</span>}
            </form>
          ) : (
            <MetricNote>Sign in as supervisor to enter RDOs.</MetricNote>
          )}
        </section>
      </div>
    </div>
  );
}
