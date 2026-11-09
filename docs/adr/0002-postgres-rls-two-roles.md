# ADR-0002: PostgreSQL row-level security with two application roles

Status: Accepted · 2026-11-08

## Context

Workspace isolation must hold even when application code forgets a filter. Login and session resolution happen before any workspace context exists.

## Decision

Two roles created by the migration runner: `ae_identity` (BYPASSRLS, granted identity tables only) used solely by the identity package; `ae_app` (NOBYPASSRLS) for everything else. RLS is enabled and forced on all tenant tables; policies require `workspace_id = app_current_workspace_id() AND app_is_member(workspace_id)` so both the request context and a real membership are needed. Context is set per transaction with `set_config(..., true)` inside `withTenant()`. `workspace_memberships` is not forced so the SECURITY DEFINER membership helpers can read it without recursion.

## Consequences

Writes that the caller may not read back cannot use `RETURNING`; ids are generated client-side where needed (decisions, audit). All tenant queries must run inside `withTenant()`.
