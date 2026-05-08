/**
 * Starter templates — pre-baked block trees that an operator can apply
 * to an empty edition. Each starter materialises into a list of
 * EditionBlock entries (the same shape `puckDataToEdition` produces),
 * so applying a starter is just `setEdition({ ...edition, blocks })`.
 *
 * The trees reference registry componentIds. The render-time path is
 * identical to a hand-built edition — no special-case starter loader
 * downstream.
 *
 * Adding a new starter: append a `StarterTemplate` to STARTERS below.
 * The `slug` is the URL-stable id; the `label` / `description` show
 * in the picker. Each entry's `props` MUST omit `id` — the loader
 * mints fresh UUIDs at apply time so multiple applications produce
 * distinct block rows.
 */

export interface StarterTemplate {
  slug: string;
  label: string;
  description: string;
  category: 'Onboarding' | 'Marketing' | 'Transactional' | 'Plain';
  /**
   * Top-level block sequence. Each entry's `type` is a registry
   * componentId; `props` carries the field defaults (no id). Slot
   * containers carry their nested children recursively in `props.children`.
   */
  blocks: ReadonlyArray<{ type: string; props: Record<string, unknown> }>;
}

// Re-export the Barebone-derived starters so callers get them via the
// same module surface. The trees in `barebone-trees.generated.ts` are
// produced by `tsx-decomposer/build-barebone-trees.ts` — run that
// script whenever the boilerplate's TSX templates change.
import { BAREBONE_STARTER_TEMPLATES } from './barebone-trees.generated.js';
export { BAREBONE_STARTER_TEMPLATES } from './barebone-trees.generated.js';

export const STARTERS: ReadonlyArray<StarterTemplate> = [
  {
    slug: 'welcome',
    label: 'Welcome',
    description: 'Logo header + Hero + bullet list + two-column features + CTA card + footer.',
    category: 'Onboarding',
    blocks: [
      {
        type: 'logo_header',
        props: { logo_url: '', brand_label: 'Your brand', logo_width: '24' },
      },
      {
        type: 'hero',
        props: {
          image_url: '',
          eyebrow: 'Thanks for joining us',
          title: 'Welcome to your brand',
          body: "You're all set. Open your dashboard to explore the basics, connect a few tools, and invite your team when you're ready.",
          cta_label: 'Open dashboard',
          cta_url: 'https://example.com',
          background: '#F3F4F6',
        },
      },
      {
        type: 'bullet_list',
        props: {
          bullet_1: 'Bring your team, tools, and workflows together in one place.',
          bullet_2: 'Permissions that match how you work — without admin overhead.',
          bullet_3: 'Connect your stack and keep updates flowing.',
          bullet_4: 'Roles, guests, and access levels handled in seconds.',
        },
      },
      {
        type: 'two_column_features',
        props: {
          left_image: '',
          left_title: 'Team workspaces',
          left_body: 'Roles, guests, and access levels so the right people see the right work — without extra admin overhead.',
          right_image: '',
          right_title: 'Connect your stack',
          right_body: 'Plug in the apps your team already uses and keep updates flowing without jumping between tabs.',
        },
      },
      {
        type: 'cta_card',
        props: {
          logo_url: '',
          headline: 'Start using your brand\nThe fastest, easiest way to get going.',
          cta_label: 'Go to dashboard',
          cta_url: 'https://example.com',
          background: '#F3F4F6',
        },
      },
      {
        type: 'social_icons_row',
        props: {
          x_url: '',
          linkedin_url: '',
          youtube_url: '',
          github_url: '',
          icon_size: '18',
          icon_set_base: '/static/shared',
        },
      },
      {
        type: 'footer',
        props: {
          footer_text: 'You are receiving this because you subscribed.\n123 Market Street, Floor 1 · Tech City, CA, 94102',
          unsubscribe_text: 'Unsubscribe',
          unsubscribe_link: '{{unsubscribe_url}}',
        },
      },
    ],
  },
  {
    slug: 'transactional',
    label: 'Transactional',
    description: 'Logo header + heading + body text + CTA button + footer. For confirmation / activation / reset emails.',
    category: 'Transactional',
    blocks: [
      {
        type: 'logo_header',
        props: { logo_url: '', brand_label: 'Your brand', logo_width: '24' },
      },
      {
        type: 'header',
        props: { title: "We're almost there!", subtitle: 'Confirm your email to finish setting up your account.' },
      },
      {
        type: 'content_section',
        props: {
          title: '',
          body: '<p>Thank you for signing up. To verify your account, just confirm your email address by clicking the button below.</p>',
        },
      },
      {
        type: 'cta_card',
        props: {
          logo_url: '',
          headline: '',
          cta_label: 'Confirm email',
          cta_url: 'https://example.com/confirm?token={{token}}',
          background: '#F3F4F6',
        },
      },
      {
        type: 'footer',
        props: {
          footer_text: "If you didn't request this, please ignore this email.",
          unsubscribe_text: '',
          unsubscribe_link: '',
        },
      },
    ],
  },
  {
    slug: 'plain-newsletter',
    label: 'Plain newsletter',
    description: 'Header + AI summary + content sections + footer. Mirrors the wizard\'s basic template.',
    category: 'Marketing',
    blocks: [
      {
        type: 'header',
        props: { title: 'This week', subtitle: '' },
      },
      {
        type: 'ai_section',
        props: {
          title: 'Summary',
          ai_body: '<p>Click <strong>Research and Draft with Helix</strong> to fill in AI content.</p>',
        },
      },
      {
        type: 'content_section',
        props: {
          title: 'In depth',
          body: '<p>Write the body of your newsletter here. The Helix AI block above will generate a summary based on a prompt; this section is for hand-authored long-form content.</p>',
        },
      },
      {
        type: 'footer',
        props: {
          footer_text: 'You are receiving this because you subscribed.',
          unsubscribe_text: 'Unsubscribe',
          unsubscribe_link: '{{unsubscribe_url}}',
        },
      },
    ],
  },
];

/**
 * Combined list — hand-built starters (curated, written using the
 * composite blocks) followed by the decomposed Barebone trees
 * (auto-generated, structurally faithful to the boilerplate's TSX).
 * The picker shows them in this order so the curated entries appear
 * first; the Barebone entries are clearly suffixed with "(Barebone)".
 */
export const ALL_STARTERS: ReadonlyArray<StarterTemplate> = [...STARTERS, ...BAREBONE_STARTER_TEMPLATES];

export function getStarter(slug: string): StarterTemplate | undefined {
  return ALL_STARTERS.find((s) => s.slug === slug);
}
