# ADR-0007: Fixed embedding dimension of 1536

Status: Accepted · 2026-11-08

## Context

pgvector columns have a fixed dimension; mixing embedding models in one index is not meaningful.

## Decision

`knowledge_chunks.embedding vector(1536)` with HNSW cosine index. The configured embedding model (`AE_EMBEDDING_MODEL`) must produce 1536 dimensions; the gateway rejects mismatches. The development embedder is a deterministic hashing embedder at 1536.

## Consequences

Changing embedding models requires a `knowledge.reindex` job across the workspace (handler exists; a migration to a new dimension would be a new column).
