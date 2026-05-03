/* @gatewaze:block name="call-to-action" category="cta" description="Centered CTA panel with headline + button" */

interface CallToActionProps {
  headline: string;
  subheadline?: string;
  primary: { label: string; href: string };
  secondary?: { label: string; href: string };
}

export function CallToAction(props: CallToActionProps) {
  return (
    <section className="rounded-2xl bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-primaryHover)] text-white p-10 sm:p-16 text-center">
      <h2 className="text-3xl sm:text-4xl font-bold">{props.headline}</h2>
      {props.subheadline && <p className="mt-4 text-lg opacity-90 max-w-2xl mx-auto">{props.subheadline}</p>}
      <div className="mt-8 flex flex-wrap justify-center gap-4">
        <a href={props.primary.href} className="px-6 py-3 rounded-lg bg-white text-[var(--color-primary)] font-medium hover:bg-gray-100">
          {props.primary.label}
        </a>
        {props.secondary && (
          <a href={props.secondary.href} className="px-6 py-3 rounded-lg border border-white/40 text-white hover:bg-white/10">
            {props.secondary.label}
          </a>
        )}
      </div>
    </section>
  );
}
