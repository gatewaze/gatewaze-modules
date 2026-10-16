import { describe, it, expect } from 'vitest';
import { parseHeadlines, fallbackHeadline, numbersIn, headlinePrompt } from '../lib/headlines.js';

const src = {
  title: 'Why Agent Evals Miss What Production Catches',
  speakers: [{ name: 'Marcelo', company: 'Pydantic', role: 'Engineer' }],
  description: 'Evals pass. Production fails. We ran 12 agents for 3 weeks and found the gap.',
  eventName: 'AGNTCon EU',
};

describe('parseHeadlines', () => {
  it('keeps drafts whose numbers come from the source and drops the rest', () => {
    const reply = `Sure: {"variants":[
      {"lead":"Agent evals pass","emph":"Production fails"},
      {"lead":"We ran 12 agents","emph":"3 weeks of truth"},
      {"lead":"AI agents break","emph":"30 real drinks"}
    ]}`;
    expect(parseHeadlines(reply, src)).toEqual([
      { lead: 'Agent evals pass', emph: 'Production fails' },
      { lead: 'We ran 12 agents', emph: '3 weeks of truth' },
    ]);
  });
  it('drops empty, overlong and duplicate drafts and caps at three', () => {
    const reply = JSON.stringify({ variants: [
      { lead: 'A', emph: '' }, { lead: 'One', emph: 'two three four five six seven' },
      { lead: 'Same', emph: 'Thing' }, { lead: 'same', emph: 'thing' },
      { lead: 'B', emph: 'C' }, { lead: 'D', emph: 'E' }, { lead: 'F', emph: 'G' },
    ] });
    expect(parseHeadlines(reply, src)).toEqual([{ lead: 'Same', emph: 'Thing' }, { lead: 'B', emph: 'C' }, { lead: 'D', emph: 'E' }]);
  });
  it('returns nothing on a reply that is not JSON', () => {
    expect(parseHeadlines('I cannot help with that.', src)).toEqual([]);
  });
  it('strips trailing punctuation and whitespace', () => {
    expect(parseHeadlines('{"variants":[{"lead":"  Evals   pass. ","emph":"Prod wins!"}]}', src)).toEqual([{ lead: 'Evals pass', emph: 'Prod wins' }]);
  });
});

describe('numbersIn', () => {
  it('normalises thousands separators and percent signs', () => {
    expect([...numbersIn('1,000 users, 14.8% better, 3 weeks')].sort()).toEqual(['1000', '14.8', '3']);
  });
});

describe('fallbackHeadline', () => {
  it('uses the speaker and the first clause of the title', () => {
    expect(fallbackHeadline({ ...src, title: 'Pull requests are dead: long live agents' })).toEqual({ lead: 'Marcelo, Pydantic', emph: 'Pull requests are dead' });
  });
  it('still returns something with no speaker', () => {
    const h = fallbackHeadline({ title: '', speakers: [], eventName: null });
    expect(h.lead).toBe('Conference talk');
    expect(h.emph).toBe('Watch the talk');
  });
});

describe('headlinePrompt', () => {
  it('carries the source and the no-invented-numbers rule', () => {
    const p = headlinePrompt(src);
    expect(p).toContain('Never invent a number');
    expect(p).toContain('Marcelo, Engineer, Pydantic');
    expect(p).toContain(src.title);
  });
});
