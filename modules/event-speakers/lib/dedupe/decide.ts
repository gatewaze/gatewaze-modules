/**
 * Deciding what to do with a group of speaker profiles that might be one
 * person.
 *
 * The asymmetry here is the whole design. A missed duplicate is untidy and a
 * human can merge it later. A wrong merge fuses two real people's talks,
 * photos and speaking history into one record, and nobody notices until one of
 * them complains. So every rule below is built to refuse rather than guess,
 * and the only things that earn an automatic merge are identifiers that belong
 * to a person rather than descriptions of them.
 *
 * Tiers, in the order they are tried:
 *
 *   1. A shared account identifier: sched user id, email, or LinkedIn slug.
 *      Merges regardless of whether the names match, because the identifier is
 *      better evidence than the name. This is what catches "Marco-Christian
 *      Krenn" and "Marco Christian-Krenn".
 *   2. A matching name, specific enough to mean something, with LinkedIn
 *      agreeing where present and contradicting nowhere.
 *   3. Everything else becomes a review candidate with a score. Never merged.
 *
 * And one absolute veto, checked before any of that: if two profiles hold
 * different LinkedIn slugs they are not merged automatically, whatever else
 * agrees. That veto is why the two Ethans and the three Jeffs stay separate.
 */

import { linkedinSlug, linkedinSlugBase, nameIsSpecific, nameKey, schedUserId } from './keys.js';

/**
 * Sources whose LinkedIn URL is a guess rather than a fact.
 *
 * enrich-speaker-linkedin.ts resolves a URL from name plus company, which is
 * the only lookup available because 10 of the 1,120 duplicate rows have an
 * email. A wrong guess hands two different people the same slug, and without
 * this list the sweep would then merge them automatically and report
 * "all profiles point at linkedin.com/in/..." as its reason.
 *
 * So a URL from one of these is downgraded: it can raise a review candidate,
 * it can never complete a merge. Removing this to raise the merge rate is the
 * one change here that could fuse two real people.
 */
const FUZZY_LINKEDIN_SOURCES = new Set(['enrichlayer_name_company']);

/** The slug, but only when we trust where it came from. */
export function trustedLinkedinSlug(r: ProfileRow): string | null {
  if (r.enrichment_source && FUZZY_LINKEDIN_SOURCES.has(r.enrichment_source)) return null;
  return linkedinSlug(r.linkedin_url);
}

export interface ProfileRow {
  id: string;
  name: string | null;
  email: string | null;
  title: string | null;
  company: string | null;
  linkedin_url: string | null;
  avatar_url: string | null;
  source_avatar_url: string | null;
  sched_user_id: string | null;
  /**
   * How linkedin_url was obtained. A fuzzy third-party match is NOT an
   * auto-merge signal; see trustedLinkedinSlug().
   */
  enrichment_source?: string | null;
  person_id: string | null;
  canonical_profile_id: string | null;
  created_at: string | null;
  /** How many events this profile is attached to, for picking the canonical. */
  event_count?: number | null;
}

export type Action = 'merge' | 'review' | 'skip';

export interface Decision {
  action: Action;
  canonicalId: string | null;
  aliasIds: string[];
  /** Short machine-readable rule name, stored on the audit row. */
  rule: string;
  /** One plain sentence for a human reading the review queue. */
  reason: string;
  /** 0 to 1. Only meaningful for 'review'. */
  score: number;
  signals: Record<string, unknown>;
}

/**
 * Which row survives a merge.
 *
 * Prefers the row that is already linked to a person, then the one attached to
 * the most events, then the most complete, then the oldest. Ties break on id so
 * two runs over the same data always choose the same canonical, which is what
 * makes the whole sweep idempotent.
 */
export function pickCanonical(rows: ProfileRow[]): ProfileRow {
  const filled = (r: ProfileRow) =>
    [r.email, r.title, r.company, r.linkedin_url, r.avatar_url, r.sched_user_id]
      .filter((v) => typeof v === 'string' && v.trim().length > 0).length;
  return [...rows].sort((a, b) => {
    const ap = a.person_id ? 1 : 0;
    const bp = b.person_id ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const ae = Number(a.event_count ?? 0);
    const be = Number(b.event_count ?? 0);
    if (ae !== be) return be - ae;
    const af = filled(a);
    const bf = filled(b);
    if (af !== bf) return bf - af;
    const at = Date.parse(a.created_at ?? '') || Number.MAX_SAFE_INTEGER;
    const bt = Date.parse(b.created_at ?? '') || Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/** True when two rows hold LinkedIn slugs that disagree. */
export function linkedinContradicts(rows: ProfileRow[]): boolean {
  const slugs = new Set(rows.map((r) => linkedinSlug(r.linkedin_url)).filter(Boolean) as string[]);
  return slugs.size > 1;
}

const SKIP: Decision = {
  action: 'skip', canonicalId: null, aliasIds: [], rule: 'nothing_to_do',
  reason: 'Only one profile in this group.', score: 0, signals: {},
};

/**
 * Decide a group.
 *
 * `rows` must all be live profiles (canonical_profile_id null) that some outer
 * query believes could be one person, either because they share an account
 * identifier or because they share a name key.
 */
export function decideGroup(rows: ProfileRow[]): Decision {
  const live = rows.filter((r) => !r.canonical_profile_id);
  if (live.length < 2) return SKIP;

  const canonical = pickCanonical(live);
  const aliasIds = live.filter((r) => r.id !== canonical.id).map((r) => r.id);
  const names = new Set(live.map((r) => nameKey(r.name)).filter(Boolean));
  // Auto-merge decisions use the TRUSTED slug; the veto and the review
  // scoring below use every slug, because a fuzzy guess that contradicts is
  // still a reason to stop and look.
  const slugs = [...new Set(live.map((r) => trustedLinkedinSlug(r)).filter(Boolean) as string[])];
  const allSlugs = [...new Set(live.map((r) => linkedinSlug(r.linkedin_url)).filter(Boolean) as string[])];
  const scheds = [...new Set(live.map((r) => r.sched_user_id ?? schedUserId(r.source_avatar_url)).filter(Boolean) as string[])];

  // ── Tier 1: a shared account identifier ────────────────────────────────
  //
  // Checked first and WITHOUT the LinkedIn veto for sched and email, because
  // those are issued by a system rather than typed, so they outrank a
  // LinkedIn URL that may just be stale or be a second account.
  if (scheds.length === 1 && live.every((r) => (r.sched_user_id ?? schedUserId(r.source_avatar_url)) === scheds[0])) {
    return {
      action: 'merge', canonicalId: canonical.id, aliasIds,
      rule: 'same_sched_user_id',
      reason: `All ${live.length} profiles are sched account ${scheds[0]}.`,
      score: 1, signals: { sched_user_id: scheds[0], names: [...names] },
    };
  }

  const emails = [...new Set(live.map((r) => (r.email ?? '').trim().toLowerCase()).filter((e) => e.includes('@')))];
  if (emails.length === 1 && live.every((r) => (r.email ?? '').trim().toLowerCase() === emails[0])) {
    return {
      action: 'merge', canonicalId: canonical.id, aliasIds,
      rule: 'same_email',
      reason: `All ${live.length} profiles use ${emails[0]}.`,
      score: 1, signals: { email: emails[0], names: [...names] },
    };
  }

  // A single shared LinkedIn slug across EVERY row. Requires every row to have
  // one, so it cannot be satisfied by one row's URL plus several blanks.
  if (slugs.length === 1 && live.every((r) => trustedLinkedinSlug(r) === slugs[0])) {
    return {
      action: 'merge', canonicalId: canonical.id, aliasIds,
      rule: 'same_linkedin',
      reason: `All ${live.length} profiles point at linkedin.com/in/${slugs[0]}.`,
      score: 1, signals: { linkedin_slug: slugs[0], names: [...names] },
    };
  }

  // ── The veto ───────────────────────────────────────────────────────────
  if (linkedinContradicts(live)) {
    return {
      action: 'review', canonicalId: canonical.id, aliasIds,
      rule: 'linkedin_contradicts',
      reason: `These share a name but hold ${allSlugs.length} different LinkedIn profiles, so they may be different people.`,
      score: 0.2, signals: { linkedin_slugs: allSlugs, names: [...names] },
    };
  }

  if (scheds.length > 1) {
    return {
      action: 'review', canonicalId: canonical.id, aliasIds,
      rule: 'sched_contradicts',
      reason: `These share a name but are different sched accounts (${scheds.join(', ')}).`,
      score: 0.1, signals: { sched_user_ids: scheds, names: [...names] },
    };
  }

  // ── Tier 2: a specific shared name, corroborated ───────────────────────
  const oneName = names.size === 1;
  const specific = live.every((r) => nameIsSpecific(r.name));

  if (!oneName || !specific) {
    return {
      action: 'review', canonicalId: canonical.id, aliasIds,
      rule: !specific ? 'name_not_specific' : 'names_differ',
      reason: !specific
        ? 'At least one of these is a single first name, which is not enough to merge on. There are already two different people here recorded only as "Ethan".'
        : 'These were grouped by an identifier but their names differ.',
      score: 0.3, signals: { names: [...names], linkedin_slugs: allSlugs },
    };
  }

  // Name matches and is specific. Merge only with corroboration: at least one
  // row carrying a LinkedIn URL (all of which agree, since the veto passed),
  // or a shared mirrored avatar, or a shared sched id.
  const withSlug = live.filter((r) => trustedLinkedinSlug(r)).length;
  if (slugs.length === 1 && withSlug >= 1) {
    return {
      action: 'merge', canonicalId: canonical.id, aliasIds,
      rule: 'same_name_linkedin_agrees',
      reason: `Same name, and the ${withSlug} profile(s) with a LinkedIn URL all point at linkedin.com/in/${slugs[0]}.`,
      score: 0.95, signals: { linkedin_slug: slugs[0], with_slug: withSlug, names: [...names] },
    };
  }

  // No corroborating identifier anywhere. This is the 337-group bulk. Score it
  // so a human sees the most likely first, and never merge it.
  const bases = [...new Set(live.map((r) => linkedinSlugBase(r.linkedin_url)).filter(Boolean) as string[])];
  const avatars = [...new Set(live.map((r) => r.avatar_url).filter(Boolean) as string[])];
  let score = 0.5;
  const signals: Record<string, unknown> = { names: [...names] };
  if (bases.length === 1 && bases[0]) { score += 0.2; signals.linkedin_slug_base = bases[0]; }
  if (avatars.length === 1 && live.filter((r) => r.avatar_url).length > 1) {
    // Corroborating, not conclusive: "Hai" and "Meri" share an avatar URL.
    score += 0.15;
    signals.shared_avatar_url = avatars[0];
  }
  const companies = [...new Set(live.map((r) => (r.company ?? '').trim().toLowerCase()).filter(Boolean))];
  signals.companies = companies;
  return {
    action: 'review', canonicalId: canonical.id, aliasIds,
    rule: 'name_only',
    reason: `Same name, no shared account identifier on any of the ${live.length} profiles.`,
    score: Math.min(0.9, score), signals,
  };
}
