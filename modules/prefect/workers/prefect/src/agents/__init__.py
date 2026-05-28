"""Claude Agent SDK session wrappers for the three pipeline stages.

Each stage has its own tool allowlist and cost budget (spec A.8 #3, A.9).
The wrapper is responsible for:

- composing the system prompt + scraped-content envelope,
- registering the permitted tools as an MCP server,
- running the agent session with CostGuard as the usage callback,
- validating the final structured output against a Pydantic schema,
- returning the validated payload (or raising on abort / schema failure).
"""
