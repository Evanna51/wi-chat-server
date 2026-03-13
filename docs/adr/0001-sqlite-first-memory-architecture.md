# ADR-0001: SQLite-first Memory Architecture

## Status
Accepted

## Context
The service started as a lightweight proactive push backend. We now need persistent AI memory with retrieval and generation support, but we still want low operational complexity and fast iteration.

## Decision
- Use SQLite as the single write source of truth for conversation, memory, graph, outbox, and audit records.
- Use asynchronous indexing from SQLite outbox into a pluggable vector store interface.
- Start with `hnswlib` implementation and keep adapter interface ready for FAISS/Qdrant.
- Never do request-path multi-storage dual writes.

## Why
- Single transaction boundary keeps consistency simple.
- Easy local development and deployment.
- Allows gradual scaling path while validating memory quality first.

## Consequences
- We need a robust outbox, retries, dead-letter queue, and replay tools.
- Vector store can lag slightly behind source-of-truth data.
- We must track idempotency keys and checkpoint progress to guarantee eventual consistency.

## Follow-up
- Add migration framework and normalized memory schema.
- Implement indexer worker and admin replay endpoint.
- Add retrieval audit and evaluation benchmark pipeline.
