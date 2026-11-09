# ADR-0003: Opaque server-side sessions; local passwords first, OIDC behind the same Principal

Status: Accepted · 2026-11-08

## Context

The brief lists OIDC/OAuth 2.1 and Entra/Auth0/Clerk. The first vertical slice needs working authentication without an external tenant.

## Decision

Random 256-bit access and refresh tokens, stored as HMAC-SHA256, httpOnly cookies, 30-minute access TTL, 14-day rotating refresh with reuse detection that revokes the chain. Passwords use scrypt. The resolved caller is a `Principal` (user, acting identity, session) that an OIDC provider will produce identically later.

## Consequences

Enterprise federation and MFA are explicit roadmap items. No JWTs are issued, so revocation is immediate and needs no propagation layer.
