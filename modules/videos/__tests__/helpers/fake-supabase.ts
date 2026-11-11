/**
 * A recording stand-in for the supabase-js query builder.
 *
 * Every chain records its table and each call made on it, and resolves to
 * whatever the test's `respond` function returns for that chain. Tests assert
 * on the recorded calls, which is how a filter that was dropped or loosened
 * shows up as a failure.
 */

export interface Call {
  op: string;
  args: unknown[];
}

export interface Chain {
  table: string;
  calls: Call[];
  /** The first argument of the first call named `op`, if any. */
  arg(op: string, index?: number): unknown;
  has(op: string, ...args: unknown[]): boolean;
}

export type Responder = (chain: Chain) => { data?: unknown; error?: unknown; count?: number | null };

export function fakeSupabase(respond: Responder) {
  const chains: Chain[] = [];

  function from(table: string) {
    const chain: Chain = {
      table,
      calls: [],
      arg(op, index = 0) {
        return this.calls.find((c) => c.op === op)?.args[index];
      },
      has(op, ...args) {
        return this.calls.some(
          (c) => c.op === op && args.every((a, i) => JSON.stringify(c.args[i]) === JSON.stringify(a)),
        );
      },
    };
    chains.push(chain);

    const builder: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            const result = { data: null, error: null, count: null, ...respond(chain) };
            return (resolve: (v: unknown) => void) => resolve(result);
          }
          return (...args: unknown[]) => {
            chain.calls.push({ op: prop, args });
            return builder;
          };
        },
      },
    );
    return builder;
  }

  return { client: { from }, chains };
}
