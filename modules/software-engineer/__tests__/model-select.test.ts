import { describe, it, expect } from 'vitest';
import { resolvePhaseModel, parseOverrideLabels, normalizeModel } from '../lib/model-select.js';

const project = (over: Record<string, unknown> = {}) => ({
  model: 'claude-sonnet-5',
  phaseModels: {},
  escalationModel: null,
  openaiCred: null,
  ...over,
});

describe('normalizeModel', () => {
  it('maps aliases and lowercases', () => {
    expect(normalizeModel('opus')).toBe('claude-opus-5');
    expect(normalizeModel('Sonnet')).toBe('claude-sonnet-5');
    expect(normalizeModel('haiku')).toBe('claude-haiku-4-5');
    expect(normalizeModel('gpt-5.2-codex')).toBe('gpt-5.2-codex');
  });
  it('rejects junk that must never reach a --model flag', () => {
    expect(normalizeModel('')).toBeNull();
    expect(normalizeModel('  ')).toBeNull();
    expect(normalizeModel('model; rm -rf /')).toBeNull();
    expect(normalizeModel('a b')).toBeNull();
    expect(normalizeModel('$(evil)')).toBeNull();
    expect(normalizeModel('x'.repeat(80))).toBeNull();
  });
});

describe('parseOverrideLabels', () => {
  it('parses model and engine labels, ignoring junk', () => {
    expect(parseOverrideLabels(['agent:model:opus', 'agent:engine:codex', 'bug'])).toEqual({
      model: 'claude-opus-5', engine: 'codex',
    });
    expect(parseOverrideLabels(['agent:model:not a model!', 'agent:engine:gemini'])).toEqual({});
    expect(parseOverrideLabels([])).toEqual({});
  });
});

describe('resolvePhaseModel', () => {
  it('defaults to the project model on claude', () => {
    expect(resolvePhaseModel(project(), null, 'implement')).toEqual({ engine: 'claude', model: 'claude-sonnet-5' });
  });

  it('applies the phase map', () => {
    const p = project({ phaseModels: { triage: { model: 'claude-haiku-4-5' } } });
    expect(resolvePhaseModel(p, null, 'triage').model).toBe('claude-haiku-4-5');
    expect(resolvePhaseModel(p, null, 'spec').model).toBe('claude-sonnet-5');
  });

  it('escalation swaps code phases only, and beats the phase map', () => {
    const p = project({ escalationModel: 'claude-opus-5', phaseModels: { implement: { model: 'claude-sonnet-5' } } });
    const run = { model_escalated: true };
    expect(resolvePhaseModel(p, run, 'implement').model).toBe('claude-opus-5');
    expect(resolvePhaseModel(p, run, 'triage').model).toBe('claude-sonnet-5');
    expect(resolvePhaseModel(p, { model_escalated: false }, 'implement').model).toBe('claude-sonnet-5');
  });

  it('run label overrides beat escalation and the map', () => {
    const p = project({ escalationModel: 'claude-opus-5' });
    const run = { model_escalated: true, model_override: 'claude-haiku-4-5' };
    expect(resolvePhaseModel(p, run, 'implement').model).toBe('claude-haiku-4-5');
  });

  it('codex requires the credential and an allowed phase', () => {
    const noCred = project({ phaseModels: { implement: { engine: 'codex', model: 'gpt-5.2-codex' } } });
    // No OpenAI cred → degrade to claude, and drop the OpenAI model name with it.
    expect(resolvePhaseModel(noCred, null, 'implement')).toEqual({ engine: 'claude', model: 'claude-sonnet-5' });

    const withCred = project({ openaiCred: 'sk-x', phaseModels: { implement: { engine: 'codex', model: 'gpt-5.2-codex' } } });
    expect(resolvePhaseModel(withCred, null, 'implement')).toEqual({ engine: 'codex', model: 'gpt-5.2-codex' });
    // Non-repo phases never run codex even when mapped.
    const triageCodex = project({ openaiCred: 'sk-x', phaseModels: { triage: { engine: 'codex', model: 'gpt-5.2-codex' } } });
    expect(resolvePhaseModel(triageCodex, null, 'triage').engine).toBe('claude');
  });

  it('run-level codex override works with a credential', () => {
    const p = project({ openaiCred: 'sk-x' });
    const run = { engine_override: 'codex', model_override: 'gpt-5.2-codex' };
    expect(resolvePhaseModel(p, run, 'implement')).toEqual({ engine: 'codex', model: 'gpt-5.2-codex' });
    // The same override on a non-repo phase degrades safely.
    expect(resolvePhaseModel(p, run, 'reflect')).toEqual({ engine: 'claude', model: 'claude-sonnet-5' });
  });

  it('a claude engine never receives a non-claude model id', () => {
    const p = project({ phaseModels: { implement: { model: 'gpt-5.2-codex' } } });
    expect(resolvePhaseModel(p, null, 'implement')).toEqual({ engine: 'claude', model: 'claude-sonnet-5' });
  });

  it('tolerates malformed project data', () => {
    expect(resolvePhaseModel({ model: null, phaseModels: null }, null, 'spec')).toEqual({ engine: 'claude', model: 'claude-sonnet-5' });
    expect(resolvePhaseModel({}, undefined, 'implement').engine).toBe('claude');
  });
});
