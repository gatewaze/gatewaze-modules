import { Hero } from '../components/Hero';
import { FeatureGrid } from '../components/FeatureGrid';
import { CallToAction } from '../components/CallToAction';

/**
 * Schema-mode home page. The page's content schema is the union of the
 * props of the components rendered here (Hero, FeatureGrid, CallToAction).
 *
 * For blocks-mode pages, gatewaze generates the route file at publish time
 * by mapping page_blocks rows to component imports.
 */
export default function HomePage() {
  return (
    <>
      <Hero
        headline="Welcome to your new gatewaze site"
        subheadline="Edit content in the gatewaze admin; push theme code via git."
        cta={{ label: 'Get started', href: '/docs/getting-started' }}
      />
      <FeatureGrid
        heading="Built for content teams"
        features={[
          { title: 'Schema-driven', description: 'Content edited via forms generated from your TypeScript prop interfaces.' },
          { title: 'Block composition', description: 'Or compose pages from a palette of theme-provided blocks.' },
          { title: 'Git as source of truth', description: 'Content + theme + audit trail all in your git repo.' },
        ]}
      />
      <CallToAction
        headline="Ready to build?"
        primary={{ label: 'Open the docs', href: '/docs/getting-started' }}
      />
    </>
  );
}
