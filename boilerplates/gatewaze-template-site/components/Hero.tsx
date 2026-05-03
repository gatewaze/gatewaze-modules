/* @gatewaze:block name="hero" category="hero" description="Top-of-page hero with headline, subheadline, and a CTA" */

interface HeroProps {
  /** @gatewaze:format richtext */
  headline: string;
  subheadline?: string;
  cta?: { label: string; href: string };
  /** @gatewaze:format image-ref */
  backgroundImage?: string;
}

export function Hero(props: HeroProps) {
  return (
    <section
      className="relative isolate py-20 sm:py-32 text-center"
      style={
        props.backgroundImage
          ? {
              backgroundImage: `url(${props.backgroundImage})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : undefined
      }
    >
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-transparent to-black/40" aria-hidden />
      <div className="max-w-3xl mx-auto px-4">
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight">{props.headline}</h1>
        {props.subheadline && (
          <p className="mt-6 text-lg sm:text-xl text-[var(--color-muted)]">{props.subheadline}</p>
        )}
        {props.cta && (
          <a
            href={props.cta.href}
            className="mt-8 inline-block px-6 py-3 rounded-lg bg-[var(--color-primary)] text-white font-medium hover:bg-[var(--color-primaryHover)]"
          >
            {props.cta.label}
          </a>
        )}
      </div>
    </section>
  );
}
