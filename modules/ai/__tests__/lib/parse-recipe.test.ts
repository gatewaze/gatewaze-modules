/**
 * parseRecipe — Goose-recipe YAML conformance tests.
 *
 * Mirrors spec-ai-workflows-and-skill-interop.md §4.2: required fields
 * (title, instructions), parameter schema, Tier-3 refusals (file input,
 * summon.delegate, Tier-3 extensions), sub-recipe path scoping, DAG
 * cycle + depth validation, version/prompt extras.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_RECIPE_DEPTH,
  parseRecipe,
  validateSubRecipeDag,
  type ParseRecipeResult,
  type RecipeRegistry,
} from '../../lib/recipes/parse-recipe.js';

const DEFAULT_CTX = { sourceId: 'src-1', pathPrefix: 'recipes/' };

function yamlBody(extra = '') {
  return `title: Sample recipe\ninstructions: Do the thing.\n${extra}`;
}

describe('parseRecipe — happy path', () => {
  it('parses minimal recipe with title + instructions', () => {
    const r = parseRecipe('recipes/foo/recipe.yaml', yamlBody(), DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.title).toBe('Sample recipe');
    expect(r.recipe.instructions).toBe('Do the thing.');
    expect(r.recipe.version).toBeNull();
    expect(r.recipe.prompt).toBeNull();
    expect(r.recipe.parameters).toEqual([]);
    expect(r.recipe.sub_recipes).toEqual([]);
    expect(r.recipe.extensions).toEqual([]);
    expect(r.recipe.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('captures version + prompt', () => {
    const yaml = `title: x\ninstructions: y\nversion: "1.0.0"\nprompt: Initial user message.`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.version).toBe('1.0.0');
    expect(r.recipe.prompt).toBe('Initial user message.');
  });

  it('captures response.json_schema', () => {
    const yaml = `title: x\ninstructions: y\nresponse:\n  json_schema:\n    type: object\n    properties:\n      foo: {type: string}`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.response_schema).toEqual({
      type: 'object',
      properties: { foo: { type: 'string' } },
    });
  });
});

describe('parseRecipe — triage / not-recipe-shaped', () => {
  it('returns not_recipe_shaped when no recipe fields present', () => {
    const r = parseRecipe('recipes/foo/recipe.yaml', 'apiVersion: v1\nkind: Pod\n', DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toBe('not_recipe_shaped');
  });

  it('flags missing title when other recipe shape is present', () => {
    const r = parseRecipe('recipes/foo/recipe.yaml', 'instructions: hi\n', DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/title required/);
  });

  it('refuses YAML scalar root', () => {
    const r = parseRecipe('recipes/foo/recipe.yaml', 'just-a-string', DEFAULT_CTX);
    expect(r.ok).toBe(false);
  });

  it('reports yaml parse errors', () => {
    const r = parseRecipe('recipes/foo/recipe.yaml', 'title: [unterminated\n', DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/yaml:/);
  });
});

describe('parseRecipe — required fields', () => {
  it('refuses empty title', () => {
    const r = parseRecipe('recipes/foo/recipe.yaml', 'title: ""\ninstructions: y', DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/title required/);
  });

  it('refuses title > 200 chars', () => {
    const yaml = `title: ${'a'.repeat(201)}\ninstructions: y`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/title exceeds 200/);
  });

  it('refuses missing instructions', () => {
    const r = parseRecipe('recipes/foo/recipe.yaml', 'title: x', DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/instructions required/);
  });

  it('refuses instructions > 16 KiB', () => {
    const yaml = `title: x\ninstructions: |\n  ${'a'.repeat(16500)}`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/instructions exceeds 16 KiB/);
  });
});

describe('parseRecipe — parameters', () => {
  it('parses string parameter with default', () => {
    const yaml = `title: x\ninstructions: y\nparameters:\n  - key: name\n    input_type: string\n    requirement: required\n    description: "User name"\n    default: "alice"`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.parameters[0]).toMatchObject({
      key: 'name',
      input_type: 'string',
      requirement: 'required',
      description: 'User name',
      default: 'alice',
    });
  });

  it('coerces user_prompt to required with warning', () => {
    const yaml = `title: x\ninstructions: y\nparameters:\n  - key: target\n    requirement: user_prompt`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.parameters[0]!.requirement).toBe('required');
    expect(r.warnings.some((w) => w.includes('user_prompt coerced'))).toBe(true);
  });

  it('refuses invalid parameter key format', () => {
    const yaml = `title: x\ninstructions: y\nparameters:\n  - key: Bad-Key`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/key.*must match/);
  });

  it('refuses select without options', () => {
    const yaml = `title: x\ninstructions: y\nparameters:\n  - key: choice\n    input_type: select`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/options must be a string/);
  });

  it('refuses file input_type as Tier-3', () => {
    const yaml = `title: x\ninstructions: y\nparameters:\n  - key: f\n    input_type: file`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'file-input-type')).toBe(true);
  });

  it('refuses {{ unknown }} reference in instructions', () => {
    const yaml = `title: x\ninstructions: "Hi {{ unknown }}"`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/undeclared parameter/);
  });

  it('accepts {{ declared }} reference', () => {
    const yaml = `title: x\ninstructions: "Hi {{ name }}"\nparameters:\n  - key: name`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
  });

  it('refuses {{ unknown }} reference in prompt', () => {
    const yaml = `title: x\ninstructions: y\nprompt: "{{ missing }}"`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/prompt references undeclared/);
  });
});

describe('parseRecipe — settings', () => {
  it('accepts valid goose_provider + goose_model', () => {
    const yaml = `title: x\ninstructions: y\nsettings:\n  goose_provider: anthropic\n  goose_model: claude-sonnet-4-5`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.settings).toEqual({
      goose_provider: 'anthropic',
      goose_model: 'claude-sonnet-4-5',
      max_turns: null,
      max_tool_repetitions: null,
    });
  });

  it('refuses unknown goose_provider', () => {
    const yaml = `title: x\ninstructions: y\nsettings:\n  goose_provider: mistral`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/goose_provider.*anthropic\|openai\|gemini\|auto/);
  });

  it('warns when goose_provider=auto', () => {
    const yaml = `title: x\ninstructions: y\nsettings:\n  goose_provider: auto`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.includes('goose_provider=auto'))).toBe(true);
  });
});

describe('parseRecipe — Tier-3 refusals (instructions)', () => {
  it('refuses summon.delegate token in instructions', () => {
    const yaml = `title: x\ninstructions: "First call summon.delegate(foo)"`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'model-driven-branching')).toBe(true);
  });

  it('refuses summon_delegate snake_case', () => {
    const yaml = `title: x\ninstructions: "Use summon_delegate to branch"`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'model-driven-branching')).toBe(true);
  });

  it('refuses delegate(...) call', () => {
    const yaml = `title: x\ninstructions: "Then delegate(child_recipe) to handle it"`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'model-driven-branching')).toBe(true);
  });
});

describe('parseRecipe — sub-recipes', () => {
  it('resolves relative sub_recipe path against parent dir', () => {
    const yaml = `title: x\ninstructions: y\nsub_recipes:\n  - name: child\n    path: ../child/recipe.yaml`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.sub_recipes[0]).toMatchObject({
      name: 'child',
      path: 'recipes/child/recipe.yaml',
    });
  });

  it('refuses sub_recipe that escapes path_prefix', () => {
    const yaml = `title: x\ninstructions: y\nsub_recipes:\n  - name: outside\n    path: ../../outside/recipe.yaml`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'cross-source-sub-recipe')).toBe(true);
  });

  it('captures activation_key + activation_value pair', () => {
    const yaml = `title: x\ninstructions: y\nsub_recipes:\n  - name: cover\n    path: ../cover/recipe.yaml\n    activation_key: status\n    activation_value: ok`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.sub_recipes[0]).toMatchObject({
      activation_key: 'status',
      activation_value: 'ok',
    });
  });

  it('refuses activation_key without activation_value', () => {
    const yaml = `title: x\ninstructions: y\nsub_recipes:\n  - name: cover\n    path: ../cover/recipe.yaml\n    activation_key: status`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/activation_key set without activation_value/);
  });

  it('refuses sub_recipe missing name', () => {
    const yaml = `title: x\ninstructions: y\nsub_recipes:\n  - path: ../child/recipe.yaml`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/name required/);
  });

  it('captures values block verbatim for runtime substitution', () => {
    const yaml = `title: x\ninstructions: y\nsub_recipes:\n  - name: child\n    path: ../child/recipe.yaml\n    values:\n      foo: "{{ outer_param }}"\n      lit: 42`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.sub_recipes[0]!.values).toEqual({
      foo: '{{ outer_param }}',
      lit: 42,
    });
  });
});

describe('parseRecipe — extensions (tier classification)', () => {
  it('accepts builtin: memory as Tier-2 (executor wires it up)', () => {
    const yaml = `title: x\ninstructions: y\nextensions:\n  - type: builtin\n    name: memory`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.extensions[0]!.tier).toBe(2);
  });

  it('accepts bare web_search as Tier-1', () => {
    const yaml = `title: x\ninstructions: y\nextensions:\n  - name: web_search`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.extensions[0]!.tier).toBe(1);
  });

  it('accepts streamable_http extension as Tier-1', () => {
    const yaml = `title: x\ninstructions: y\nextensions:\n  - type: streamable_http\n    name: my-mcp\n    uri: https://example.com/mcp`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.extensions[0]!.tier).toBe(1);
  });

  it('refuses stdio extension not in allowlist', () => {
    const yaml = `title: x\ninstructions: y\nextensions:\n  - type: stdio\n    cmd: /usr/bin/evil`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'tier-3-extension')).toBe(true);
  });

  it('accepts stdio extension on allowlist', () => {
    const yaml = `title: x\ninstructions: y\nextensions:\n  - type: stdio\n    cmd: /usr/local/bin/safe-tool`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, {
      ...DEFAULT_CTX,
      stdioAllowlist: ['/usr/local/bin/safe-tool'],
    });
    expect(r.ok).toBe(true);
  });
});

describe('parseRecipe — version + prompt extras', () => {
  it('refuses version > 32 chars', () => {
    const yaml = `title: x\ninstructions: y\nversion: "${'1'.repeat(33)}"`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/version exceeds 32/);
  });

  it('refuses prompt > 16 KiB', () => {
    const yaml = `title: x\ninstructions: y\nprompt: |\n  ${'a'.repeat(16500)}`;
    const r = parseRecipe('recipes/foo/recipe.yaml', yaml, DEFAULT_CTX);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/prompt exceeds 16 KiB/);
  });
});

describe('validateSubRecipeDag', () => {
  function okRecipe(subPaths: string[]): ParseRecipeResult {
    return {
      ok: true,
      recipe: {
        version: null,
        title: 'x',
        description: null,
        instructions: 'y',
        prompt: null,
        parameters: [],
        response_schema: null,
        settings: { goose_provider: null, goose_model: null },
        sub_recipes: subPaths.map((p) => ({
          name: p,
          path: p,
          values: {},
          activation_key: null,
          activation_value: null,
        })),
        extensions: [],
        content_hash: 'x',
      },
      warnings: [],
    };
  }

  it('detects cycle a -> b -> a', () => {
    const registry: RecipeRegistry = {
      byPath: new Map([
        ['recipes/a.yaml', okRecipe(['recipes/b.yaml'])],
        ['recipes/b.yaml', okRecipe(['recipes/a.yaml'])],
      ]),
    };
    const refusals = validateSubRecipeDag('recipes/a.yaml', registry);
    expect(refusals.some((f) => f.feature === 'sub-recipe-cycle')).toBe(true);
  });

  it('detects depth exceeded', () => {
    const byPath = new Map<string, ParseRecipeResult>();
    // chain a0 -> a1 -> ... -> aN where N > MAX_RECIPE_DEPTH
    for (let i = 0; i <= MAX_RECIPE_DEPTH + 1; i++) {
      const next = `recipes/a${i + 1}.yaml`;
      byPath.set(`recipes/a${i}.yaml`, okRecipe([next]));
    }
    byPath.set(`recipes/a${MAX_RECIPE_DEPTH + 2}.yaml`, okRecipe([]));
    const refusals = validateSubRecipeDag('recipes/a0.yaml', { byPath });
    expect(refusals.some((f) => f.feature === 'sub-recipe-depth-exceeded')).toBe(true);
  });

  it('returns empty when DAG is acyclic and within depth', () => {
    const registry: RecipeRegistry = {
      byPath: new Map([
        ['recipes/a.yaml', okRecipe(['recipes/b.yaml'])],
        ['recipes/b.yaml', okRecipe([])],
      ]),
    };
    expect(validateSubRecipeDag('recipes/a.yaml', registry)).toEqual([]);
  });
});
