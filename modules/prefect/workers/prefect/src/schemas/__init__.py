"""Pydantic schemas validating LLM outputs and internal state transitions.

Every agent output that ends up in the database MUST pass through a schema
here (spec A.8 #5). This is the last line of defense against prompt-injection
payloads that try to write malformed data.
"""
