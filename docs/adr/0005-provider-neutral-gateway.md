# ADR-0005: Provider-neutral Model Gateway with two wire adapters

Status: Accepted · 2026-11-08

## Context

No module may call a provider directly; adapters must normalize streaming, usage, refusals, errors, citations and tool calls across many providers.

## Decision

`ModelGateway { generate, stream, embed, health, isConfigured }` and `ProviderAdapter` per wire protocol: `anthropic` (Messages API) and `openai-compatible` (OpenAI, DeepSeek, xAI, Perplexity, vLLM, Ollama, TGI, Together, RunPod, dev stub). Adapters yield a closed `ModelEvent` vocabulary and never throw for provider-side problems. Credentials are resolved by `credentialRef` through a `CredentialBroker`.

## Consequences

Adding a provider that speaks either protocol is a registry row, not code. Google (Gemini) needs a third adapter or its OpenAI-compatible endpoint; tracked in ROADMAP.
