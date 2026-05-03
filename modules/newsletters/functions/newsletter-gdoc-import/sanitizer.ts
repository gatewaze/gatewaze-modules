/**
 * Content sanitizer for imported newsletter content.
 * Validates URLs, strips dangerous HTML, and validates AI output against schemas.
 */

const ALLOWED_PROTOCOLS = ['https:', 'http:', 'mailto:'];
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li']);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
};

/**
 * Sanitize a URL — strip dangerous protocols.
 */
export function sanitizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      return url;
    }
    return null;
  } catch {
    // Relative URLs or malformed — strip
    return null;
  }
}

/**
 * Sanitize HTML content — only allow safe tags and attributes.
 */
export function sanitizeHtml(html: string): string {
  // Strip all tags except allowed ones
  let cleaned = html;

  // Remove script, style, iframe, etc. entirely (including content)
  cleaned = cleaned.replace(/<(script|style|iframe|object|embed|form|input|textarea|select)[^>]*>[\s\S]*?<\/\1>/gi, '');
  cleaned = cleaned.replace(/<(script|style|iframe|object|embed|form|input|textarea|select)[^>]*\/?>/gi, '');

  // Remove event handlers from all remaining tags
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '');

  // Strip tags not in allowlist (keep content)
  cleaned = cleaned.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tagName) => {
    const tag = tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';

    // For allowed tags, strip disallowed attributes
    if (match.startsWith('</')) return `</${tag}>`;

    const allowedAttrsForTag = ALLOWED_ATTRS[tag];
    if (!allowedAttrsForTag) return `<${tag}>`;

    // Extract and keep only allowed attributes
    const attrMatches = match.matchAll(/\s([a-zA-Z-]+)\s*=\s*"([^"]*)"/g);
    const attrs: string[] = [];
    for (const [, attrName, attrValue] of attrMatches) {
      if (allowedAttrsForTag.has(attrName.toLowerCase())) {
        // Extra sanitization for href
        if (attrName.toLowerCase() === 'href') {
          const sanitized = sanitizeUrl(attrValue);
          if (sanitized) attrs.push(`${attrName}="${sanitized}"`);
        } else {
          attrs.push(`${attrName}="${attrValue}"`);
        }
      }
    }

    return attrs.length > 0 ? `<${tag} ${attrs.join(' ')}>` : `<${tag}>`;
  });

  return cleaned;
}

/**
 * Sanitize all URLs in a content object (recursively).
 */
export function sanitizeContentUrls(content: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(content)) {
    if (typeof value === 'string') {
      // Check if this looks like a URL field
      if (key.includes('url') || key.includes('link') || key.includes('href')) {
        result[key] = sanitizeUrl(value) ?? '';
      } else {
        result[key] = value;
      }
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'object' && item !== null) {
          return sanitizeContentUrls(item as Record<string, unknown>);
        }
        return item;
      });
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeContentUrls(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Validate and sanitize an AI mapping result's content against a schema.
 */
export function sanitizeBlockContent(
  content: Record<string, unknown>,
  schema: Record<string, unknown> | null
): Record<string, unknown> {
  // Sanitize URLs throughout
  let sanitized = sanitizeContentUrls(content);

  // Sanitize HTML fields (those with format: "html" in the schema)
  if (schema && typeof schema === 'object') {
    const properties = (schema as any).properties as Record<string, any> | undefined;
    if (properties) {
      for (const [key, fieldSchema] of Object.entries(properties)) {
        if (fieldSchema?.format === 'html' && typeof sanitized[key] === 'string') {
          sanitized[key] = sanitizeHtml(sanitized[key] as string);
        }
      }
    }
  }

  return sanitized;
}
