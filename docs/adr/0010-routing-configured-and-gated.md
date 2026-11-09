# ADR-0010: Routing excludes unconfigured providers; experimental status is workspace-gated

Status: Accepted · 2026-11-08

## Context

Early testing showed Auto selecting models whose provider key was absent, burning fallback attempts. The brief requires experimental checkpoints to be isolated until approved.

## Decision

`gateway.isConfigured()` (no network call) filters candidates before ranking; exclusions are recorded in the answer path. Models that are not APPROVED, or whose profile is EXPERIMENTAL, are routable only in workspaces with `allowExperimentalModels`; REJECTED is never routable. "No configured model" yields UNSUPPORTED; "configured but excluded by policy" yields AUTHORIZATION_DENIED.

## Consequences

Operators see configuration gaps in the UI (Models screen shows "not configured"); users never see a fake answer from an unreachable model.
