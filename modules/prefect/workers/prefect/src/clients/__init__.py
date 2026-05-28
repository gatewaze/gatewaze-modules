"""Low-level HTTP/SDK clients used by the worker.

Each client is a thin wrapper that (a) injects the right auth credentials,
(b) funnels calls through the shared rate_limiter, and (c) validates
responses before returning to the agent.

The scoped Supabase clients here implement the A.8 security model: the
`agent_reader` and `agent_writer` roles are enforced at the database
level via signed JWTs, not in Python.
"""
