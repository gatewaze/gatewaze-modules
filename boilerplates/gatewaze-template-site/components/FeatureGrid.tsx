/* @gatewaze:block name="feature-grid" category="content" description="Grid of features with icons + headings" */

interface Feature {
  /** @gatewaze:format image-ref */
  icon?: string;
  title: string;
  description: string;
}

interface FeatureGridProps {
  heading?: string;
  features: Feature[];
  /** Number of columns at lg breakpoint. */
  columns?: 2 | 3 | 4;
}

export function FeatureGrid(props: FeatureGridProps) {
  const cols = props.columns ?? 3;
  const colsClass =
    cols === 2 ? 'lg:grid-cols-2' : cols === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3';
  return (
    <section className="py-16">
      {props.heading && <h2 className="text-3xl font-bold text-center mb-12">{props.heading}</h2>}
      <div className={`grid grid-cols-1 sm:grid-cols-2 ${colsClass} gap-8`}>
        {props.features.map((feat, i) => (
          <div key={i} className="p-6">
            {feat.icon && <img src={feat.icon} alt="" className="w-12 h-12 mb-4" />}
            <h3 className="text-lg font-semibold mb-2">{feat.title}</h3>
            <p className="text-[var(--color-muted)]">{feat.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
