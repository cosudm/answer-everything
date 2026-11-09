# ADR-0012: Terraform on Azure Container Apps for DEV/UAT/PROD

Status: Accepted · 2026-11-08

## Context

The brief allows Bicep or Terraform, Azure or S3-compatible storage, and names Entra, Azure AI Foundry and Service Bus. Containers without Kubernetes are required.

## Decision

One Terraform module (`infra/terraform/modules/platform`) instantiated per environment: Container Apps (api, worker, web), PostgreSQL Flexible Server 16 with `vector`, Key Vault (RBAC) for secrets, Blob Storage for originals, Service Bus namespace for the future queue adapter, Log Analytics + Application Insights. Provider keys are placed in Key Vault out of band.

## Consequences

The skeleton is complete and consistent across environments but has not been applied to a live subscription from this build environment; first apply is a tracked task.
