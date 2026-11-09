# ADR-0008: A labelled development provider instead of silent mocks

Status: Accepted · 2026-11-08

## Context

The build environment has no outbound access to model providers, and the brief forbids replacing real integrations with silent mock behaviour.

## Decision

`tools/dev-provider` is a real HTTP server speaking the OpenAI-compatible protocol, registered as provider `local-dev` with `deploymentType=LOCAL`, `evaluationStatus=TESTING`, display name "Local Development Model (stub)", routing priority -100, skipped by the seed in prod and refused by the gateway in prod. Its answers say they are templated. Adapter tests run against it and against a protocol-faithful fake Anthropic server.

## Consequences

The entire pipeline runs for real in development and CI; nothing pretends to be a model. Live-provider verification is a documented first step after deployment.
