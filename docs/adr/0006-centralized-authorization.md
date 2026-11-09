# ADR-0006: Centralized deny-by-default authorization; decisions persisted in their own transaction

Status: Accepted · 2026-11-08

## Context

Capability is not authority. Every protected operation must be decided in one place, and denials must be durable even when the caller rolls back.

## Decision

A pure `evaluate(request, facts)` policy engine (P-IDENTITY, P-AGENT, P-PLATFORM-ADMIN, P-SELF, P-MEMBERSHIP, P-CROSS-WORKSPACE, P-ROLE, P-OWNERSHIP, P-PRIVACY-WORKSPACE, P-AI-USE, P-MODEL, P-ACTION-GATEWAY) wrapped by `AuthorizationService`, which loads facts from the database and persists decisions and denial audit events through a dedicated pool/transaction.

## Consequences

Policies are unit-tested exhaustively without a database; the database suites prove the integration. A thrown `AuthorizationDeniedError` leaves the denial on record.
