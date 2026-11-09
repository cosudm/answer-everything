# ADR-0011: Browser calls the API directly with httpOnly cookies and CORS

Status: Accepted · 2026-11-08

## Context

Streaming through a Next.js rewrite risks buffering; the API must own authentication.

## Decision

The web app calls the API origin directly (`NEXT_PUBLIC_API_URL`) with `credentials: include`; the API allows the web origin with credentials and sets httpOnly cookies. SSE is consumed with `fetch` + a stream reader (POST bodies are needed).

## Consequences

Production fronts both under one parent domain so cookies are same-site. The API is also usable by non-browser clients with Bearer tokens.
