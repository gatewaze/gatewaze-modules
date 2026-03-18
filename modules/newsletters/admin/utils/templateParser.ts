/**
 * Newsletter Template Parser
 *
 * Parses Mustache-style templates with {{variable}} syntax.
 * Supports:
 * - Simple variables: {{variable}}
 * - Sections (conditionals/loops): {{#section}}...{{/section}}
 * - Inverted sections: {{^section}}...{{/section}}
 * - Comments: {{! comment }}
 */

export interface TemplateVariable {
  name: string;
  type: 'variable' | 'section' | 'inverted_section';
  path: string[];
  raw: string;
}

/**
 * Extract all variables from a template string
 */
export function extractVariables(template: string): TemplateVariable[] {
  const variables: TemplateVariable[] = [];
  const seen = new Set<string>();

  // Match {{variable}}, {{#section}}, {{/section}}, {{^inverted}}
  const regex = /\{\{([#^/]?)([^}]+)\}\}/g;
  let match;

  while ((match = regex.exec(template)) !== null) {
    const [raw, prefix, name] = match;
    const trimmedName = name.trim();

    // Skip comments and closing tags
    if (trimmedName.startsWith('!') || prefix === '/') {
      continue;
    }

    // Skip Customer.io specific variables
    if (trimmedName.includes('%')) {
      continue;
    }

    const key = `${prefix}${trimmedName}`;
    if (!seen.has(key)) {
      seen.add(key);

      let type: TemplateVariable['type'] = 'variable';
      if (prefix === '#') type = 'section';
      if (prefix === '^') type = 'inverted_section';

      variables.push({
        name: trimmedName,
        type,
        path: trimmedName.split('.'),
        raw,
      });
    }
  }

  return variables;
}

/**
 * Render a template with given data
 * This is a simple Mustache-like renderer
 */
export function renderTemplate(template: string, data: Record<string, unknown>): string {
  let result = template;

  // Process sections first ({{#section}}...{{/section}})
  result = processSections(result, data);

  // Process inverted sections ({{^section}}...{{/section}})
  result = processInvertedSections(result, data);

  // Process simple variables ({{variable}})
  result = processVariables(result, data);

  return result;
}

/**
 * Process section tags {{#section}}...{{/section}}
 */
function processSections(template: string, data: Record<string, unknown>): string {
  const sectionRegex = /\{\{#([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

  return template.replace(sectionRegex, (match, key, content) => {
    const trimmedKey = key.trim();
    const value = getNestedValue(data, trimmedKey);

    if (value === null || value === undefined || value === false) {
      return '';
    }

    if (Array.isArray(value)) {
      // Render for each item in array
      return value.map((item, index) => {
        const itemData = typeof item === 'object' ? item : { '.': item };
        return renderTemplate(content, { ...data, ...itemData, '@index': index });
      }).join('');
    }

    if (typeof value === 'object') {
      // Render with object as context
      return renderTemplate(content, { ...data, ...value });
    }

    // Truthy value, render content
    return renderTemplate(content, data);
  });
}

/**
 * Process inverted section tags {{^section}}...{{/section}}
 */
function processInvertedSections(template: string, data: Record<string, unknown>): string {
  const invertedRegex = /\{\{\^([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

  return template.replace(invertedRegex, (match, key, content) => {
    const trimmedKey = key.trim();
    const value = getNestedValue(data, trimmedKey);

    // Render if value is falsy or empty array
    if (!value || (Array.isArray(value) && value.length === 0)) {
      return renderTemplate(content, data);
    }

    return '';
  });
}

/**
 * Process simple variable tags {{variable}}
 */
function processVariables(template: string, data: Record<string, unknown>): string {
  const variableRegex = /\{\{([^#^/!][^}]*)\}\}/g;

  return template.replace(variableRegex, (match, key) => {
    const trimmedKey = key.trim();

    // Preserve Customer.io specific variables
    if (trimmedKey.includes('%')) {
      return match;
    }

    // Special "." refers to current context (used in array loops)
    if (trimmedKey === '.') {
      const value = data['.'];
      return value !== undefined ? String(value) : '';
    }

    const value = getNestedValue(data, trimmedKey);

    if (value === null || value === undefined) {
      return '';
    }

    // Don't escape HTML - we want to preserve it for rich text fields
    return String(value);
  });
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * Validate template syntax
 */
export function validateTemplate(template: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const openTags: string[] = [];

  const regex = /\{\{([#^/]?)([^}]+)\}\}/g;
  let match;

  while ((match = regex.exec(template)) !== null) {
    const [, prefix, name] = match;
    const trimmedName = name.trim();

    // Skip comments
    if (trimmedName.startsWith('!')) {
      continue;
    }

    if (prefix === '#' || prefix === '^') {
      openTags.push(trimmedName);
    } else if (prefix === '/') {
      const lastOpen = openTags.pop();
      if (lastOpen !== trimmedName) {
        errors.push(`Mismatched closing tag: expected {{/${lastOpen}}} but found {{/${trimmedName}}}`);
      }
    }
  }

  if (openTags.length > 0) {
    errors.push(`Unclosed section tags: ${openTags.map(t => `{{#${t}}}`).join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
