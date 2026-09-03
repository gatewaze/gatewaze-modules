// @ts-nocheck
/**
 * Isolates one test-env panel's render tree from the rest of the Overview /
 * run-detail page.
 *
 * The Environments section (multi-env cards) and the per-profile test-env
 * panels poll several endpoints on independent timers (env list, env
 * status, the activity log) while the host agent is mid-deploy — a window
 * where the registry/status shape it renders is, by definition, still
 * changing. Before this boundary existed, an uncaught render error anywhere
 * in that tree (a bad field in a mid-transition poll response, for example)
 * unmounted the whole subtree — including every one of those polling
 * `useEffect`s — with nothing left to recover it short of a full page
 * reload. From the outside that reads exactly like "the Environments
 * section is gone": the rest of the Overview page (Runs, PRs, stats) keeps
 * working because it lives in sibling components with their own effects,
 * unaffected by a throw here.
 *
 * "Retry" remounts the subtree via the `key` bump, which re-fires its
 * effects against whatever the box currently reports — by the time someone
 * clicks it, almost certainly past whatever transient shape tripped the
 * original error.
 */
import React from 'react';

export default class TestEnvErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  { error: Error | null; key: number }
> {
  state = { error: null as Error | null, key: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // No error-reporting service is wired into this module — this is the
    // only trace of the failure once it happens, so keep it, and keep the
    // component stack (points at exactly which env card/panel threw).
    // eslint-disable-next-line no-console
    console.error(`[test-env] ${this.props.label ?? 'panel'} render error`, error, info.componentStack);
  }

  retry = () => this.setState((s) => ({ error: null, key: s.key + 1 }));

  render() {
    if (this.state.error) {
      return (
        <div className="mb-3 rounded-md border border-[#8b5a2b]/40 bg-[#8b5a2b]/10 px-3 py-2 text-xs text-[#8b5a2b] dark:border-[#d9a66c]/40 dark:bg-[#d9a66c]/10 dark:text-[#d9a66c]">
          {this.props.label ?? 'This panel'} hit an error and stopped updating.
          <button
            type="button"
            onClick={this.retry}
            className="ml-2 underline decoration-[#8b5a2b]/60 underline-offset-2 hover:text-[#6b4423] dark:decoration-[#d9a66c]/60 dark:hover:text-[#f0dcc0]"
          >
            Retry
          </button>
        </div>
      );
    }
    // key bump forces a full remount on retry — a fresh mount re-runs every
    // effect below (env list poll, status poll, activity log poll) from
    // scratch rather than trying to resume state that may have caused the
    // throw.
    return <React.Fragment key={this.state.key}>{this.props.children}</React.Fragment>;
  }
}
