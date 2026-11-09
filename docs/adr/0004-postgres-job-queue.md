# ADR-0004: PostgreSQL-backed job queue behind a broker-neutral interface

Status: Accepted · 2026-11-08

## Context

Ingestion and evaluation must run asynchronously. The brief suggests Service Bus or SQS, and also warns against infrastructure before usage justifies it.

## Decision

`JobQueue` interface in `@ae/events`; MVP implementation uses a `jobs` table with `FOR UPDATE SKIP LOCKED`, attempts, backoff and a DEAD state. Service Bus is provisioned in Terraform for a later adapter. Handlers run AS the requesting user THROUGH the platform SERVICE identity so RLS applies to background work.

## Consequences

No extra infrastructure for the MVP; one more table to monitor. Switching brokers touches one package.
