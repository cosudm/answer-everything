# Infrastructure

One Terraform module (`modules/platform`) instantiated three times (`envs/dev`, `envs/uat`, `envs/prod`).

| Concern   | Resource                                             | dev          | uat          | prod                                                  |
| --------- | ---------------------------------------------------- | ------------ | ------------ | ----------------------------------------------------- |
| Compute   | Azure Container Apps (api, worker, web)              | 1 replica    | 1 replica    | 2+ replicas, autoscale                                |
| Database  | PostgreSQL Flexible Server 16 + pgvector             | B1ms, public | D2ds, public | D4ds, zone-redundant HA, private only, 35-day backups |
| Secrets   | Key Vault (RBAC)                                     | soft delete  | soft delete  | purge protection, private                             |
| Originals | Blob Storage, private, versioned                     | LRS          | LRS          | GRS                                                   |
| Queue     | Service Bus namespace + `jobs` queue (future broker) | Basic        | Basic        | Standard                                              |
| Telemetry | Log Analytics + Application Insights                 | 30 days      | 30 days      | 90 days                                               |

Provider API keys are **never** in Terraform or state. Place them in Key Vault under the names listed in
`provider_secret_names` and reference them from Container Apps as secrets. The application reads them through
the Credential Broker by `credentialRef`.

```
cd infra/terraform/envs/dev
terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```

After the first apply, run migrations and the registry seed once from CI (`node dist/migrate.js migrate && node dist/seed.js`
inside the API image) with `DATABASE_URL` set to the admin connection string.
