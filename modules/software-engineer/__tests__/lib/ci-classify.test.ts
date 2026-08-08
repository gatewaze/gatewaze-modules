import { describe, it, expect } from 'vitest';
import { classifyJobDeterministic, classifyDeterministic, INFRA_LOG_PATTERNS } from '../../lib/ci-classify';

describe('classifyJobDeterministic', () => {
  it('empty steps → infra (cancelled/startup_failure at 0 steps)', () => {
    expect(classifyJobDeterministic({ name: 'build', steps: [], conclusion: 'cancelled' })).toBe('infra');
  });

  it('cancelled with no completed steps → infra', () => {
    expect(
      classifyJobDeterministic({
        name: 'build',
        conclusion: 'cancelled',
        steps: [{ status: 'queued', conclusion: null }, { status: 'in_progress', conclusion: null }],
      }),
    ).toBe('infra');
  });

  it('startup_failure with no completed steps → infra', () => {
    expect(
      classifyJobDeterministic({
        name: 'build',
        conclusion: 'startup_failure',
        steps: [{ status: 'queued', conclusion: null }],
      }),
    ).toBe('infra');
  });

  it('cancelled but with a completed step → ambiguous (not a pure infra cancel)', () => {
    expect(
      classifyJobDeterministic({
        name: 'build',
        conclusion: 'cancelled',
        steps: [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }],
      }),
    ).toBe('ambiguous');
  });

  it('each INFRA_LOG_PATTERNS entry, when matched in the log tail, resolves to infra', () => {
    const samples = [
      'Failed to resolve action download info for actions/checkout',
      'Error: Service Unavailable',
      'Failed to download some index files',
      'the self-hosted runner has been lost',
      'the self-hosted runner has been removed',
      'timeout waiting for job — no steps ran',
    ];
    // Two samples cover the 'lost'/'removed' alternation of one pattern, so samples outnumber patterns.
    expect(samples.length).toBeGreaterThanOrEqual(INFRA_LOG_PATTERNS.length);
    for (const logTail of samples) {
      expect(
        classifyJobDeterministic({
          name: 'build',
          conclusion: 'failure',
          steps: [{ status: 'completed', conclusion: 'failure' }],
          logTail,
        }),
      ).toBe('infra');
    }
  });

  it('a normal failed job with real steps and no infra pattern → ambiguous', () => {
    expect(
      classifyJobDeterministic({
        name: 'test',
        conclusion: 'failure',
        steps: [
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'failure' },
        ],
        logTail: 'AssertionError: expected 1 to equal 2',
      }),
    ).toBe('ambiguous');
  });
});

describe('classifyDeterministic', () => {
  it('all failing checks resolve to infra → external, with a reason per check', () => {
    const result = classifyDeterministic({
      failingChecks: [
        { name: 'build', job: { name: 'build', steps: [], conclusion: 'cancelled' } },
        { name: 'test', job: { name: 'test', steps: [], conclusion: 'startup_failure' } },
      ],
      baseFailingCheckNames: new Set(),
    });
    expect(result.verdict).toBe('external');
    expect(result.reasons).toHaveLength(2);
    expect(result.ambiguousChecks).toHaveLength(0);
  });

  it('a check name present in baseFailingCheckNames → external, reason cites main', () => {
    const result = classifyDeterministic({
      failingChecks: [{ name: 'pnpm-audit', job: null }],
      baseFailingCheckNames: new Set(['pnpm-audit']),
    });
    expect(result.verdict).toBe('external');
    expect(result.reasons[0]).toMatch(/red on main/);
  });

  it('a mix of infra + one non-matching check → ambiguous, with only the unresolved check listed', () => {
    const result = classifyDeterministic({
      failingChecks: [
        { name: 'build', job: { name: 'build', steps: [], conclusion: 'cancelled' } },
        { name: 'lint', job: { name: 'lint', steps: [{ status: 'completed', conclusion: 'failure' }], conclusion: 'failure' } },
      ],
      baseFailingCheckNames: new Set(),
    });
    expect(result.verdict).toBe('ambiguous');
    expect(result.ambiguousChecks).toEqual(['lint']);
    expect(result.reasons).toHaveLength(1);
  });

  it('empty failingChecks → external (vacuous, defensive)', () => {
    const result = classifyDeterministic({ failingChecks: [], baseFailingCheckNames: new Set() });
    expect(result.verdict).toBe('external');
    expect(result.ambiguousChecks).toHaveLength(0);
  });

  it('a check with no job info and not on the base-red list → ambiguous', () => {
    const result = classifyDeterministic({
      failingChecks: [{ name: 'custom-check', job: null }],
      baseFailingCheckNames: new Set(),
    });
    expect(result.verdict).toBe('ambiguous');
    expect(result.ambiguousChecks).toEqual(['custom-check']);
  });
});
