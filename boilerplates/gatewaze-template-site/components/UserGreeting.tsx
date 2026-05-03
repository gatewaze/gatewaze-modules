/* @gatewaze:block kind="user-personalized" name="user-greeting" category="content" audience="authenticated_optional" description="Personalized greeting for logged-in users; generic welcome for anonymous viewers" */

interface UserGreetingProps {
  fallbackHeadline: string;
  /** Optional CTA shown to anonymous viewers. */
  signupCta?: { label: string; href: string };
}

export function UserGreeting(props: UserGreetingProps & { user?: { full_name?: string; email: string } | null }) {
  if (props.user) {
    return (
      <div className="py-8">
        <h2 className="text-2xl font-bold">
          Welcome back, {props.user.full_name?.split(' ')[0] ?? props.user.email.split('@')[0]}
        </h2>
      </div>
    );
  }
  return (
    <div className="py-8">
      <h2 className="text-2xl font-bold">{props.fallbackHeadline}</h2>
      {props.signupCta && (
        <a
          href={props.signupCta.href}
          className="mt-4 inline-block px-5 py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium"
        >
          {props.signupCta.label}
        </a>
      )}
    </div>
  );
}
