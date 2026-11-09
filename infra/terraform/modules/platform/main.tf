# Answer Everything platform module: one environment (dev / uat / prod).
# Containers on Azure Container Apps, PostgreSQL Flexible Server with pgvector,
# Key Vault for provider credentials, Storage for originals, Service Bus for the
# queue (the MVP uses the PostgreSQL queue; the namespace is provisioned so the
# switch is a configuration change), Log Analytics + Application Insights.

terraform {
  required_version = ">= 1.7"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

locals {
  name   = "ae-${var.environment}"
  tags   = merge({ product = "answer-everything", environment = var.environment, managed_by = "terraform" }, var.tags)
  is_prod = var.environment == "prod"
}

resource "azurerm_resource_group" "rg" {
  name     = "${local.name}-rg"
  location = var.location
  tags     = local.tags
}

# ------------------------------------------------------------------ observability
resource "azurerm_log_analytics_workspace" "law" {
  name                = "${local.name}-law"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku                 = "PerGB2018"
  retention_in_days   = local.is_prod ? 90 : 30
  tags                = local.tags
}

resource "azurerm_application_insights" "appi" {
  name                = "${local.name}-appi"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  workspace_id        = azurerm_log_analytics_workspace.law.id
  application_type    = "web"
  tags                = local.tags
}

# ------------------------------------------------------------------ secrets
data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "kv" {
  name                        = replace("${local.name}-kv", "-", "")
  location                    = azurerm_resource_group.rg.location
  resource_group_name         = azurerm_resource_group.rg.name
  tenant_id                   = data.azurerm_client_config.current.tenant_id
  sku_name                    = "standard"
  purge_protection_enabled    = local.is_prod
  soft_delete_retention_days  = 30
  enable_rbac_authorization   = true
  public_network_access_enabled = !local.is_prod
  tags                        = local.tags
}

# Provider credentials are placed in Key Vault out of band (never in Terraform
# state) under the names used by credentialRef in the model registry.
variable "provider_secret_names" {
  type    = list(string)
  default = ["ANTHROPIC-API-KEY", "OPENAI-API-KEY", "DEEPSEEK-API-KEY", "XAI-API-KEY", "PERPLEXITY-API-KEY", "PRIVATE-INFERENCE-API-KEY"]
}

resource "random_password" "session_secret" {
  length  = 48
  special = false
}

resource "random_password" "db_admin" {
  length  = 32
  special = false
}

resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "random_password" "db_identity" {
  length  = 32
  special = false
}

resource "azurerm_key_vault_secret" "session_secret" {
  name         = "AE-SESSION-SECRET"
  value        = random_password.session_secret.result
  key_vault_id = azurerm_key_vault.kv.id
}

# ------------------------------------------------------------------ database
resource "azurerm_postgresql_flexible_server" "pg" {
  name                          = "${local.name}-pg"
  resource_group_name           = azurerm_resource_group.rg.name
  location                      = azurerm_resource_group.rg.location
  version                       = "16"
  administrator_login           = "aeadmin"
  administrator_password        = random_password.db_admin.result
  sku_name                      = var.postgres_sku
  storage_mb                    = var.postgres_storage_mb
  backup_retention_days         = local.is_prod ? 35 : 7
  geo_redundant_backup_enabled  = local.is_prod
  public_network_access_enabled = !local.is_prod
  zone                          = "1"
  tags                          = local.tags

  dynamic "high_availability" {
    for_each = local.is_prod ? [1] : []
    content { mode = "ZoneRedundant" }
  }
}

resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.pg.id
  value     = "VECTOR,PGCRYPTO,PG_TRGM"
}

resource "azurerm_postgresql_flexible_server_database" "db" {
  name      = "answer_everything"
  server_id = azurerm_postgresql_flexible_server.pg.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# ------------------------------------------------------------------ storage (originals)
resource "azurerm_storage_account" "blob" {
  name                            = replace("${local.name}blob", "-", "")
  resource_group_name             = azurerm_resource_group.rg.name
  location                        = azurerm_resource_group.rg.location
  account_tier                    = "Standard"
  account_replication_type        = local.is_prod ? "GRS" : "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  tags                            = local.tags
  blob_properties {
    versioning_enabled = true
    delete_retention_policy { days = local.is_prod ? 30 : 7 }
  }
}

resource "azurerm_storage_container" "knowledge" {
  name                  = "knowledge-originals"
  storage_account_id    = azurerm_storage_account.blob.id
  container_access_type = "private"
}

# ------------------------------------------------------------------ queue (future broker)
resource "azurerm_servicebus_namespace" "sb" {
  name                = "${local.name}-sb"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku                 = local.is_prod ? "Standard" : "Basic"
  tags                = local.tags
}

resource "azurerm_servicebus_queue" "jobs" {
  name         = "jobs"
  namespace_id = azurerm_servicebus_namespace.sb.id
}

# ------------------------------------------------------------------ container apps
resource "azurerm_container_app_environment" "cae" {
  name                       = "${local.name}-cae"
  location                   = azurerm_resource_group.rg.location
  resource_group_name        = azurerm_resource_group.rg.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id
  tags                       = local.tags
}

resource "azurerm_user_assigned_identity" "apps" {
  name                = "${local.name}-apps-id"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "apps_kv" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.apps.principal_id
}

resource "azurerm_role_assignment" "apps_blob" {
  scope                = azurerm_storage_account.blob.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.apps.principal_id
}

locals {
  common_env = {
    AE_ENV                         = var.environment
    NODE_ENV                       = "production"
    LOG_LEVEL                      = local.is_prod ? "info" : "debug"
    AE_COOKIE_SECURE               = "true"
    AE_DEFAULT_ALLOW_EXPERIMENTAL  = "false"
    AE_INLINE_JOBS                 = "false"
    AE_EMBEDDING_MODEL             = var.embedding_model
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.appi.connection_string
    OTEL_SERVICE_NAME              = "answer-everything-api"
    DATABASE_URL          = "postgres://aeadmin:${random_password.db_admin.result}@${azurerm_postgresql_flexible_server.pg.fqdn}:5432/answer_everything?sslmode=require"
    DATABASE_APP_URL      = "postgres://ae_app:${random_password.db_app.result}@${azurerm_postgresql_flexible_server.pg.fqdn}:5432/answer_everything?sslmode=require"
    DATABASE_IDENTITY_URL = "postgres://ae_identity:${random_password.db_identity.result}@${azurerm_postgresql_flexible_server.pg.fqdn}:5432/answer_everything?sslmode=require"
    AE_DB_APP_PASSWORD        = random_password.db_app.result
    AE_DB_IDENTITY_PASSWORD   = random_password.db_identity.result
  }
}

resource "azurerm_container_app" "api" {
  name                         = "${local.name}-api"
  container_app_environment_id = azurerm_container_app_environment.cae.id
  resource_group_name          = azurerm_resource_group.rg.name
  revision_mode                = "Single"
  tags                         = local.tags
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }
  ingress {
    external_enabled = true
    target_port      = 4000
    transport        = "http"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
  secret {
    name                = "ae-session-secret"
    key_vault_secret_id = azurerm_key_vault_secret.session_secret.versionless_id
    identity            = azurerm_user_assigned_identity.apps.id
  }
  template {
    min_replicas = local.is_prod ? 2 : 1
    max_replicas = local.is_prod ? 10 : 2
    container {
      name   = "api"
      image  = var.api_image
      cpu    = local.is_prod ? 1.0 : 0.5
      memory = local.is_prod ? "2Gi" : "1Gi"
      env {
        name        = "AE_SESSION_SECRET"
        secret_name = "ae-session-secret"
      }
      env {
        name  = "WEB_PUBLIC_URL"
        value = var.web_public_url
      }
      env {
        name  = "API_PUBLIC_URL"
        value = var.api_public_url
      }
      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }
      liveness_probe {
        transport = "HTTP"
        path      = "/health"
        port      = 4000
      }
    }
  }
}

resource "azurerm_container_app" "worker" {
  name                         = "${local.name}-worker"
  container_app_environment_id = azurerm_container_app_environment.cae.id
  resource_group_name          = azurerm_resource_group.rg.name
  revision_mode                = "Single"
  tags                         = local.tags
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }
  template {
    min_replicas = 1
    max_replicas = local.is_prod ? 4 : 1
    container {
      name   = "worker"
      image  = var.worker_image
      cpu    = 0.5
      memory = "1Gi"
      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

resource "azurerm_container_app" "web" {
  name                         = "${local.name}-web"
  container_app_environment_id = azurerm_container_app_environment.cae.id
  resource_group_name          = azurerm_resource_group.rg.name
  revision_mode                = "Single"
  tags                         = local.tags
  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "http"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
  template {
    min_replicas = local.is_prod ? 2 : 1
    max_replicas = local.is_prod ? 6 : 2
    container {
      name   = "web"
      image  = var.web_image
      cpu    = 0.5
      memory = "1Gi"
    }
  }
}
