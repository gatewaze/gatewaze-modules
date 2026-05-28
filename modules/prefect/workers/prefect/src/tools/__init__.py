"""Custom MCP tools exposed to Claude Agent SDK sessions.

Each tool is registered via `create_sdk_mcp_server()` and wraps a narrow
operation (scrape, insert, search). Tool-call allowlists per stage live
in `agents/` — this package only defines the tools themselves.
"""
