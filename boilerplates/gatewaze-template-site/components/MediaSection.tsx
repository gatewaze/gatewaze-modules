/* @gatewaze:block name="media-section" category="media" description="Two-column layout: media on one side, text on the other" */

interface MediaSectionProps {
  /** @gatewaze:format image-ref */
  image: string;
  imageAlt?: string;
  heading: string;
  /** @gatewaze:format markdown */
  body: string;
  imageSide?: 'left' | 'right';
  cta?: { label: string; href: string };
}

export function MediaSection(props: MediaSectionProps) {
  const reverse = props.imageSide === 'right';
  return (
    <section className={`py-16 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center ${reverse ? 'lg:[direction:rtl]' : ''}`}>
      <div className={reverse ? '[direction:ltr]' : ''}>
        <img src={props.image} alt={props.imageAlt ?? ''} className="rounded-lg w-full" />
      </div>
      <div className={reverse ? '[direction:ltr]' : ''}>
        <h2 className="text-3xl font-bold mb-4">{props.heading}</h2>
        <div className="prose prose-neutral" dangerouslySetInnerHTML={{ __html: props.body }} />
        {props.cta && (
          <a href={props.cta.href} className="mt-6 inline-block px-5 py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium">
            {props.cta.label}
          </a>
        )}
      </div>
    </section>
  );
}
