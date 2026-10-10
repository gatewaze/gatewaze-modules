/**
 * Tests for the events.linuxfoundation.org parsers.
 *
 * The bug these pin: AGNTCon + MCPCon Europe had no
 * `source_details.action_links.schedule`, even though `schedule` has been in
 * the allowlist since the scraper was written and its LF page carries a
 * Schedule link. The cause was the surface, not the allowlist — LF moved its
 * action buttons off the listing card and into the event page's nav, so the
 * card-only parser could not see them.
 *
 * Every fixture in __fixtures__ is a verbatim slice of the live site on
 * 2026-10-10. The assertions are written against the real markup, including the
 * two traps in it: the "Program" dropdown parent is an allowlisted label whose
 * href is only `#`, and the real Schedule link sits one <ul> deeper inside that
 * parent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  extractCardActionLinks,
  extractNavActionLinks,
  mergeActionLinks,
  extractSchedHost,
  buildScheduleSource,
} from '../lf-event-page.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

const EVENT_PAGE = fixture('lf-event-page.html');
const ARCHIVE_CARD = fixture('lf-listing-card-archive.html');
const UPCOMING_CARD = fixture('lf-listing-card-upcoming.html');
const SCHEDULE_PAGE = fixture('lf-schedule-page-embed.html');


describe('extractCardActionLinks', () => {
  test('an upcoming-listing card carries no action links at all', () => {
    // This is the regression itself: the card template the scraper was
    // written against is gone. If LF ever puts the buttons back, this
    // assertion is the thing that should be updated — not silently relied on.
    assert.deepEqual(extractCardActionLinks(UPCOMING_CARD), {});
  });

  test('an archive card carries only Videos', () => {
    assert.deepEqual(extractCardActionLinks(ARCHIVE_CARD), {
      videos: 'https://www.youtube.com/@AgenticAI-Foundation',
    });
  });

  test('the event-title link is not mistaken for an action link', () => {
    const links = extractCardActionLinks(ARCHIVE_CARD);
    assert.ok(!Object.values(links).includes('https://events.linuxfoundation.org/agntcon-mcpcon-europe/'));
  });

  test('a href="#" is never stored, even for an allowlisted label', () => {
    assert.deepEqual(extractCardActionLinks('<a href="#">Register</a>'), {});
  });

  test('a non-http scheme is never stored', () => {
    assert.deepEqual(
      extractCardActionLinks('<a href="javascript:alert(1)">Register</a>'),
      {},
    );
    // Entity-encoded, since the href is decoded before the scheme check.
    assert.deepEqual(
      extractCardActionLinks('<a href="&#106;avascript:alert(1)">Register</a>'),
      {},
    );
  });

  test('ampersands in a href are decoded', () => {
    assert.deepEqual(
      extractCardActionLinks('<a href="https://example.test/a?b=1&#038;c=2">Register</a>'),
      { register: 'https://example.test/a?b=1&c=2' },
    );
  });

  test('a stored URL cannot carry an attribute breakout', () => {
    // These URLs are persisted into events.source_details for other modules to
    // read, so they are percent-encoded here rather than left to whatever
    // renders them next.
    const links = extractCardActionLinks(
      '<a href="https://evil.test/?x=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">Register</a>',
    );
    assert.equal(links.register, 'https://evil.test/?x=%22%3E%3Cscript%3Ealert(1)%3C/script%3E');
    assert.ok(!links.register.includes('"'));
    assert.ok(!links.register.includes('<'));
  });

  test('a real LF action URL survives normalisation unchanged', () => {
    assert.deepEqual(
      extractCardActionLinks(
        '<a href="https://events.linuxfoundation.org/agntcon-mcpcon-europe/program/schedule/">Schedule</a>'
        + '<a href="https://www.youtube.com/@AgenticAI-Foundation">Videos</a>',
      ),
      {
        schedule: 'https://events.linuxfoundation.org/agntcon-mcpcon-europe/program/schedule/',
        videos: 'https://www.youtube.com/@AgenticAI-Foundation',
      },
    );
  });

  test('a page of unterminated anchors parses in linear time', () => {
    // The regression guard for the parser's shape. The obvious single-regex
    // version of this parser took 5.3 s on 1,200 repetitions of
    // `<a href="x" ` and grew cubically; Node being single-threaded, that
    // stalls the whole scraper worker. 20,000 reps is ~240 KB, the size of a
    // real LF page.
    const payload = '<a href="x" '.repeat(20_000);
    const started = Date.now();
    assert.deepEqual(extractCardActionLinks(payload), {});
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `took ${elapsed}ms — the parser is backtracking again`);
  });

  test('many well-formed opens sharing one distant close parse in linear time', () => {
    // The second quadratic shape, found by the security re-review after the
    // first one was fixed. Caching the close-tag search was not enough: every
    // opening tag still re-sliced and re-stripped the same long span, which
    // took 4.9 s at 432 KB. Bounding the label span fixed it.
    const payload = `${'<a href="https://x.test/p">'.repeat(16_000)}</a>`;
    const started = Date.now();
    assert.deepEqual(extractCardActionLinks(payload), {});
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `took ${elapsed}ms — the work per opening tag is unbounded again`);
  });

  test('an anchor body longer than a label is not read as one', () => {
    // Padded with a comment, which stripTags drops, so the label itself is
    // "register" either way and only the distance to `</a>` differs.
    const pad = (n) => `<!--${'y'.repeat(n)}-->`;
    assert.deepEqual(
      extractCardActionLinks(`<a href="https://x.test/">${pad(600)}Register</a>`),
      {},
    );
    assert.deepEqual(
      extractCardActionLinks(`<a href="https://x.test/">${pad(400)}Register</a>`),
      { register: 'https://x.test/' },
    );
  });

  test('HTML larger than the parse cap is skipped rather than walked', () => {
    const huge = `<a href="https://example.test/">Register</a>${'x'.repeat(4_000_001)}`;
    assert.deepEqual(extractCardActionLinks(huge), {});
  });

  test('first occurrence of a label wins', () => {
    assert.deepEqual(
      extractCardActionLinks(
        '<a href="https://example.test/one">Register</a><a href="https://example.test/two">Register</a>',
      ),
      { register: 'https://example.test/one' },
    );
  });
});


describe('extractNavActionLinks', () => {
  const nav = extractNavActionLinks(EVENT_PAGE);

  test('captures the schedule link — the bug this fix exists for', () => {
    assert.equal(
      nav.schedule,
      'https://events.linuxfoundation.org/agntcon-mcpcon-europe/program/schedule/',
    );
  });

  test('captures register alongside it', () => {
    assert.equal(
      nav.register,
      'https://events.linuxfoundation.org/agntcon-mcpcon-europe/register/',
    );
  });

  test('drops the dropdown parents, whose href is only "#"', () => {
    // "Attend" and "Program" are both allowlisted labels on this page. Stored
    // unfiltered, "program" would land in action_links pointing at nothing.
    assert.ok(!('attend' in nav), 'attend should not be captured');
    assert.ok(!('program' in nav), 'program should not be captured');
  });

  test('does not invent labels the page does not have', () => {
    // This event is over, so its sponsor page is gone. action_links must
    // describe the page as it is today.
    assert.deepEqual(Object.keys(nav).sort(), ['register', 'schedule']);
  });

  test('a page with no event-menu nav yields nothing rather than throwing', () => {
    assert.deepEqual(extractNavActionLinks('<html><body><p>nope</p></body></html>'), {});
    assert.deepEqual(extractNavActionLinks(''), {});
    assert.deepEqual(extractNavActionLinks(null), {});
  });

  test('an unclosed nav still yields its links rather than nothing', () => {
    const page = '<nav class="event-menu"><a href="https://x.test/s/">Schedule</a>';
    assert.deepEqual(extractNavActionLinks(page), { schedule: 'https://x.test/s/' });
  });

  test('a nested nav does not end the outer one early', () => {
    // HTML5 allows <nav> inside <nav>, so the close tag has to be depth-
    // matched. Taking the first </nav> dropped the Register link, which sits
    // after the inner nav's close and before the outer one's.
    const page = '<nav class="event-menu outer">'
      + '<nav class="event-menu inner">decorative</nav>'
      + '<a href="https://x.test/register">Register</a>'
      + '</nav>';
    assert.deepEqual(extractNavActionLinks(page), { register: 'https://x.test/register' });
  });

  test('two sibling navs both contribute — the overlap guard only skips nested ones', () => {
    // LF renders the menu twice (desktop and mobile popout), so this is the
    // real shape, and the scannedTo guard must not swallow the second copy.
    const page = '<nav class="event-menu"><a href="https://a.test/r">Register</a></nav>'
      + '<nav class="event-menu"><a href="https://b.test/s">Schedule</a></nav>';
    assert.deepEqual(extractNavActionLinks(page), {
      register: 'https://a.test/r',
      schedule: 'https://b.test/s',
    });
  });

  test('the earlier nav wins when both carry the same label', () => {
    const page = '<nav class="event-menu"><a href="https://first.test/">Schedule</a></nav>'
      + '<nav class="event-menu"><a href="https://second.test/">Schedule</a></nav>';
    assert.deepEqual(extractNavActionLinks(page), { schedule: 'https://first.test/' });
  });

  test('many nav openings sharing one close are scanned once, in linear time', () => {
    // Without the overlap guard each opening handed the anchor scan almost the
    // whole document again, which is quadratic however cheap one pass is.
    const page = `${'<nav class="event-menu">'.repeat(16_000)}<a href="https://x.test/s">Schedule</a></nav>`;
    const started = Date.now();
    assert.deepEqual(extractNavActionLinks(page), { schedule: 'https://x.test/s' });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `took ${elapsed}ms — overlapping navs are being rescanned`);
  });

  test('a nav whose class merely contains the token as a substring is skipped', () => {
    const page = '<nav class="not-event-menu-thing"><a href="https://x.test/s/">Schedule</a></nav>';
    assert.deepEqual(extractNavActionLinks(page), {});
  });

  test('a "Register" link in the page body does not beat the nav', () => {
    const page = `<a href="https://body.test/register">Register</a>${EVENT_PAGE}`;
    assert.equal(
      extractNavActionLinks(page).register,
      'https://events.linuxfoundation.org/agntcon-mcpcon-europe/register/',
    );
  });
});


describe('mergeActionLinks', () => {
  test('the real AGNTCon shape: videos from the card, schedule from the nav', () => {
    const merged = mergeActionLinks(
      extractCardActionLinks(ARCHIVE_CARD),
      extractNavActionLinks(EVENT_PAGE),
    );
    assert.deepEqual(merged, {
      videos: 'https://www.youtube.com/@AgenticAI-Foundation',
      register: 'https://events.linuxfoundation.org/agntcon-mcpcon-europe/register/',
      schedule: 'https://events.linuxfoundation.org/agntcon-mcpcon-europe/program/schedule/',
    });
  });

  test('the card wins where both surfaces carry a label', () => {
    assert.deepEqual(
      mergeActionLinks(
        { register: 'https://card.test/' },
        { register: 'https://nav.test/', schedule: 'https://nav.test/s/' },
      ),
      { register: 'https://card.test/', schedule: 'https://nav.test/s/' },
    );
  });

  test('tolerates either side being missing', () => {
    assert.deepEqual(mergeActionLinks({ videos: 'https://v.test/' }, undefined), {
      videos: 'https://v.test/',
    });
    assert.deepEqual(mergeActionLinks(undefined, { schedule: 'https://s.test/' }), {
      schedule: 'https://s.test/',
    });
    assert.deepEqual(mergeActionLinks(undefined, undefined), {});
  });
});


describe('extractSchedHost', () => {
  test('resolves the host from the event page, with no extra fetch', () => {
    assert.equal(extractSchedHost(EVENT_PAGE), 'agntconmcpconeu26.sched.com');
  });

  test('resolves it from a schedule page embed script too', () => {
    // `<script src="//host.sched.com/js/embed.js">` — the shape §5.2 names.
    assert.equal(extractSchedHost(SCHEDULE_PAGE), 'agntconmcpconeu26.sched.com');
  });

  test('resolves it from an iframe embed', () => {
    assert.equal(
      extractSchedHost('<iframe src="https://mcpseoul2026.sched.com/?iframe=yes"></iframe>'),
      'mcpseoul2026.sched.com',
    );
  });

  test('null when the page references no sched programme', () => {
    // MCP Dev Summit Toronto is the live example: its LF page and its schedule
    // page both carry nothing, so the importer must stay on its own fallback.
    assert.equal(extractSchedHost(ARCHIVE_CARD), null);
    assert.equal(extractSchedHost('<html></html>'), null);
    assert.equal(extractSchedHost(''), null);
    assert.equal(extractSchedHost(null), null);
  });

  test("sched.com's own subdomains are not an event host", () => {
    assert.equal(extractSchedHost('<a href="https://www.sched.com/">Sched</a>'), null);
    assert.equal(extractSchedHost('<a href="https://help.sched.com/article">Help</a>'), null);
    // A real host after a reserved one is still found.
    assert.equal(
      extractSchedHost('<a href="https://www.sched.com/">x</a><a href="https://mcpseoul2026.sched.com/">y</a>'),
      'mcpseoul2026.sched.com',
    );
  });

  test('a lookalike host is not matched', () => {
    assert.equal(extractSchedHost('<a href="https://evil.sched.com.attacker.test/">x</a>'), null);
    assert.equal(extractSchedHost('<a href="https://notsched.example/">x</a>'), null);
  });
});


describe('buildScheduleSource', () => {
  test('the shape the event-agenda importer reads', () => {
    assert.deepEqual(buildScheduleSource('agntconmcpconeu26.sched.com'), {
      kind: 'sched',
      host: 'agntconmcpconeu26.sched.com',
      url: 'https://agntconmcpconeu26.sched.com/',
      resolved_from: 'lf_event_page',
    });
  });

  test('null in, null out — so a stale host can never be persisted', () => {
    assert.equal(buildScheduleSource(null), null);
    assert.equal(buildScheduleSource(undefined), null);
    assert.equal(buildScheduleSource(''), null);
  });
});
