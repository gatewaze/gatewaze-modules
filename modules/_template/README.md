# Template module

A starting point you copy to build a new Gatewaze module. Duplicate this
directory, rename it, and edit the manifest to taste — the step-by-step copy
instructions live in the header comment of [`index.ts`](./index.ts).

## Before you commit

Run a security review of your diff (`/security-review`, the `pragma:security`
skill, or `/pragma:review`) and fix what it finds. Every change that touches
code gets a security pass before it is committed — see
[`CLAUDE.md`](../../CLAUDE.md) and [`SECURITY.md`](../../SECURITY.md).
