import {
    CLOSED_STATES,
    dueStatus,
    NOT_FINISHED_STATES,
    waitingColor,
    waitingDaysSince,
    waitingLabel,
    WAITING_DANGER_DAYS,
    WAITING_UNKNOWN,
    WAITING_WARNING_DAYS,
    WAITING_WEEKS_FROM_DAYS
} from '../../../src/client/components/taskBoard.shared';
import type {Translate, TranslatePlural} from '../../../src/client/lib/i18n';

// The one spec in this suite that talks to nothing: the board's two duration functions are pure
// (see the header of taskBoard.shared.ts), so they are imported from the module's own source and
// called directly, with the instant they are asked about supplied as an argument. That is the whole
// reason both take a `now`/`createdDate` pair rather than reading the clock inside: an SLA
// indicator whose boundaries can only be observed by waiting a real day is one nobody checks.
//
// It runs under Cypress rather than a separate unit runner so the module keeps ONE test toolchain
// (tests/package.json) instead of gaining a second one for four functions; nothing here needs a
// browser, a Jahia, or a site, so it is also the fastest spec in the suite and the one that still
// passes when no instance is running.

// A fixed "now" every case below is expressed relative to, rather than Date.now(): with a moving
// reference the 5/6/10/11-day boundaries would drift into each other on a slow machine.
const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// An ISO instant exactly `days` (plus an optional extra number of hours) before NOW.
function daysAgo(days: number, extraHours = 0): string {
    return new Date(NOW - (days * MS_PER_DAY) - (extraHours * 60 * 60 * 1000)).toISOString();
}

function daysFromNow(days: number): string {
    return new Date(NOW + (days * MS_PER_DAY)).toISOString();
}

// The two halves of the i18n bridge, stubbed to return exactly what the fallback path returns when
// no i18next instance exists (see ../lib/i18n.ts): the English default, interpolated. That is what
// the board actually renders on the SSR-island path, so asserting against it is asserting against a
// real rendering, not against a test-only shape.
const t: Translate = (_key, defaultValue, options) => (options
    ? defaultValue.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
        (Object.prototype.hasOwnProperty.call(options, name) ? String(options[name]) : whole))
    : defaultValue);

const tPlural: TranslatePlural = (key, count, one, other) => t(key, count === 1 ? one : other, {count});

describe('Waiting duration and due status (pure board logic, no Jahia involved)', () => {
    describe('waitingDaysSince', () => {
        it('counts whole elapsed 24h periods, not calendar days', () => {
            // 25 hours ago is 1 day even though it crosses two midnights -- this is an age, not a
            // date difference.
            expect(waitingDaysSince(daysAgo(0, 25), NOW)).to.equal(1);
            expect(waitingDaysSince(daysAgo(0, 23), NOW)).to.equal(0);
            expect(waitingDaysSince(daysAgo(3), NOW)).to.equal(3);
        });

        it('clamps a future creation date to 0 rather than reporting a negative age', () => {
            expect(waitingDaysSince(daysFromNow(2), NOW)).to.equal(0);
        });

        it('reports the unknown sentinel for a missing or unparseable date', () => {
            expect(waitingDaysSince(null, NOW)).to.equal(WAITING_UNKNOWN);
            expect(waitingDaysSince('not-a-date', NOW)).to.equal(WAITING_UNKNOWN);
        });
    });

    describe('waitingLabel', () => {
        it('says "today" below one whole day and pluralizes days above it', () => {
            expect(waitingLabel(t, tPlural, 0)).to.equal('today');
            expect(waitingLabel(t, tPlural, 1)).to.equal('1 day');
            expect(waitingLabel(t, tPlural, 2)).to.equal('2 days');
        });

        // The days -> weeks switchover, from both sides of it: 13 days is still "13 days", 14 is
        // "2 weeks" (14 / 7), and the division floors -- 20 days is 2 weeks, not 3.
        it(`switches from days to weeks at ${WAITING_WEEKS_FROM_DAYS} days`, () => {
            expect(waitingLabel(t, tPlural, WAITING_WEEKS_FROM_DAYS - 1)).to.equal('13 days');
            expect(waitingLabel(t, tPlural, WAITING_WEEKS_FROM_DAYS)).to.equal('2 weeks');
            expect(waitingLabel(t, tPlural, 20)).to.equal('2 weeks');
            expect(waitingLabel(t, tPlural, 21)).to.equal('3 weeks');
        });

        it('says "unknown" for the unknown sentinel', () => {
            expect(waitingLabel(t, tPlural, WAITING_UNKNOWN)).to.equal('unknown');
        });
    });

    // The escalation boundaries, asserted on both sides of each: the thresholds are strict
    // ">" comparisons, so 5 and 10 days are still the lower colour and 6 and 11 are the higher one.
    describe('waitingColor escalation boundaries', () => {
        it(`stays default up to and including ${WAITING_WARNING_DAYS} days`, () => {
            expect(waitingColor(0)).to.equal('default');
            expect(waitingColor(WAITING_WARNING_DAYS)).to.equal('default');
        });

        it(`warns from ${WAITING_WARNING_DAYS + 1} days up to and including ${WAITING_DANGER_DAYS}`, () => {
            expect(waitingColor(WAITING_WARNING_DAYS + 1)).to.equal('warning');
            expect(waitingColor(WAITING_DANGER_DAYS)).to.equal('warning');
        });

        it(`escalates to danger from ${WAITING_DANGER_DAYS + 1} days`, () => {
            expect(waitingColor(WAITING_DANGER_DAYS + 1)).to.equal('danger');
            expect(waitingColor(60)).to.equal('danger');
        });

        it('has no colour to escalate for an unknown age', () => {
            expect(waitingColor(WAITING_UNKNOWN)).to.equal('default');
        });
    });

    describe('dueStatus', () => {
        it('is "none" without a usable due date', () => {
            expect(dueStatus(null, 'active', NOW)).to.equal('none');
            expect(dueStatus('not-a-date', 'active', NOW)).to.equal('none');
        });

        it('is "due" while the date is still ahead and "overdue" once it has passed', () => {
            expect(dueStatus(daysFromNow(1), 'active', NOW)).to.equal('due');
            expect(dueStatus(daysAgo(1), 'active', NOW)).to.equal('overdue');
        });

        // Every open state overdues; every closed one never does, however long ago the date went
        // by. Driven off the module's own two state lists so a state added to either is covered
        // here the moment it is declared, rather than at the next time someone remembers.
        it('overdues in every open state', () => {
            NOT_FINISHED_STATES.forEach(state => {
                expect(dueStatus(daysAgo(30), state, NOW), state).to.equal('overdue');
            });
        });

        it('never overdues a closed task (finished, cancelled)', () => {
            expect(CLOSED_STATES).to.have.members(['finished', 'cancelled']);
            CLOSED_STATES.forEach(state => {
                expect(dueStatus(daysAgo(30), state, NOW), state).to.equal('due');
            });
        });

        it('overdues a task whose state could not be read at all', () => {
            // A null state is not a closed one: nothing says the work stopped, so a passed date
            // still means what it says.
            expect(dueStatus(daysAgo(1), null, NOW)).to.equal('overdue');
        });
    });
});
