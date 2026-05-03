/* @gatewaze:block name="testimonial" category="content" description="Single customer quote with avatar + name + role" */

interface TestimonialProps {
  quote: string;
  author: string;
  role?: string;
  /** @gatewaze:format image-ref */
  avatar?: string;
}

export function Testimonial(props: TestimonialProps) {
  return (
    <figure className="max-w-2xl mx-auto py-12 text-center">
      <blockquote className="text-2xl font-medium leading-snug">
        <p>“{props.quote}”</p>
      </blockquote>
      <figcaption className="mt-6 flex items-center justify-center gap-4">
        {props.avatar && <img src={props.avatar} alt="" className="w-12 h-12 rounded-full" />}
        <div className="text-left">
          <div className="font-semibold">{props.author}</div>
          {props.role && <div className="text-sm text-[var(--color-muted)]">{props.role}</div>}
        </div>
      </figcaption>
    </figure>
  );
}
