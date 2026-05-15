/**
 * Two-tier pricing comparison — side-by-side cards highlighting one
 * tier as recommended. Common in upsell emails.
 */

import { Button, Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface PricingComparisonProps extends Record<string, unknown> {
  t1_name: string;
  t1_price: string;
  t1_features: string;
  t1_cta_label: string;
  t1_cta_url: string;
  t2_name: string;
  t2_price: string;
  t2_features: string;
  t2_cta_label: string;
  t2_cta_url: string;
  recommended_tier: '1' | '2';
  accent_color: string;
}

function Tier({ name, price, features, cta_label, cta_url, recommended, accent }: {
  name: string; price: string; features: string; cta_label: string; cta_url: string; recommended: boolean; accent: string;
}) {
  const featureLines = features.split('\n').filter((f) => f.trim());
  return (
    <Column
      style={{
        width: '50%',
        verticalAlign: 'top',
        padding: '24px',
        backgroundColor: recommended ? accent : '#FFFFFF',
        color: recommended ? '#FFFFFF' : '#111827',
        border: recommended ? 'none' : `1px solid #E5E7EB`,
        borderRadius: 8,
      }}
    >
      <Text style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 1, color: 'inherit' }}>
        {name}
      </Text>
      <Text style={{ margin: '0 0 16px', fontSize: 32, fontWeight: 700, color: 'inherit' }}>{price}</Text>
      {featureLines.map((f, i) => (
        <Text key={i} style={{ margin: '0 0 6px', fontSize: 13, color: 'inherit' }}>• {f}</Text>
      ))}
      {cta_label && cta_url ? (
        <Button
          href={cta_url}
          style={{
            display: 'inline-block',
            marginTop: 16,
            backgroundColor: recommended ? '#FFFFFF' : accent,
            color: recommended ? accent : '#FFFFFF',
            padding: '10px 18px',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {cta_label}
        </Button>
      ) : null}
    </Column>
  );
}

export const PricingComparisonBlock: EmailBlockEntry<PricingComparisonProps> = {
  componentId: 'pricing_comparison',
  label: 'Pricing comparison',
  category: 'Pricing',
  fields: {
    t1_name: { type: 'text', label: 'Tier 1 — name' },
    t1_price: { type: 'text', label: 'Tier 1 — price' },
    // contentEditable disabled — render does `features.split('\n')` which
    // needs a raw string; the inline-edit wrapper turns it into an object.
    t1_features: { type: 'textarea', label: 'Tier 1 — features (one per line)', contentEditable: false },
    t1_cta_label: { type: 'text', label: 'Tier 1 — CTA label' },
    t1_cta_url: { type: 'text', label: 'Tier 1 — CTA URL' },
    t2_name: { type: 'text', label: 'Tier 2 — name' },
    t2_price: { type: 'text', label: 'Tier 2 — price' },
    // contentEditable disabled — see t1_features above.
    t2_features: { type: 'textarea', label: 'Tier 2 — features (one per line)', contentEditable: false },
    t2_cta_label: { type: 'text', label: 'Tier 2 — CTA label' },
    t2_cta_url: { type: 'text', label: 'Tier 2 — CTA URL' },
    recommended_tier: {
      type: 'select',
      label: 'Recommended tier',
      options: [
        { label: 'Tier 1', value: '1' },
        { label: 'Tier 2', value: '2' },
      ],
    },
    accent_color: { type: 'text', label: 'Accent colour (recommended tier)' },
  },
  defaultProps: {
    t1_name: 'Starter',
    t1_price: '$0',
    t1_features: '3 projects\nBasic analytics\nCommunity support',
    t1_cta_label: 'Get started',
    t1_cta_url: '#',
    t2_name: 'Pro',
    t2_price: '$29',
    t2_features: 'Unlimited projects\nAdvanced analytics\nPriority support\nCustom domains',
    t2_cta_label: 'Start trial',
    t2_cta_url: '#',
    recommended_tier: '2',
    accent_color: '#2563EB',
  },
  Component: (p) => (
    <Section style={{ padding: '32px 0' }}>
      <Row>
        <Tier
          name={p.t1_name}
          price={p.t1_price}
          features={p.t1_features}
          cta_label={p.t1_cta_label}
          cta_url={p.t1_cta_url}
          recommended={p.recommended_tier === '1'}
          accent={p.accent_color}
        />
        <Tier
          name={p.t2_name}
          price={p.t2_price}
          features={p.t2_features}
          cta_label={p.t2_cta_label}
          cta_url={p.t2_cta_url}
          recommended={p.recommended_tier === '2'}
          accent={p.accent_color}
        />
      </Row>
    </Section>
  ),
};
