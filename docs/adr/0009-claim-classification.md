# ADR-0009: Deterministic claim classification by citation coverage; verification pass deferred

Status: Accepted · 2026-11-08

## Context

The answer contract requires every material assertion to be classifiable. A second model call per answer is expensive, and a classifier that guesses would violate "never pretend to know".

## Decision

When sources were available: sentences carrying matching `[S#]` markers are SOURCED_FACT linked to citations; recommendation language yields RECOMMENDATION; everything else is UNCERTAIN ("not traced to a source"). When no sources were available, no claims are extracted and the answer carries the NO_SOURCES_RETRIEVED limitation. Confidence is the share of material claims that are sourced, labelled as evidence coverage. A verification pass (`answer.verify_claims`) will later upgrade UNCERTAIN to INFERENCE/SUPPORTED/CONTRADICTED.

## Consequences

Honest and cheap; under-states confidence for well-reasoned uncited prose. The UI explains the basis on every answer.
