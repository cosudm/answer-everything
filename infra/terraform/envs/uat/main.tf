terraform {
  required_version = ">= 1.7"
  backend "azurerm" {
    # Configure per environment: resource_group_name, storage_account_name,
    # container_name = "tfstate", key = "answer-everything-uat.tfstate"
  }
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

provider "azurerm" {
  features {}
}

module "platform" {
  source              = "../../modules/platform"
  environment         = "uat"
  location            = var.location
  postgres_sku        = var.postgres_sku
  postgres_storage_mb = var.postgres_storage_mb
  api_image           = var.api_image
  worker_image        = var.worker_image
  web_image           = var.web_image
  web_public_url      = var.web_public_url
  api_public_url      = var.api_public_url
  embedding_model     = var.embedding_model
  tags                = { cost_center = "answer-everything" }
}

output "api_fqdn" { value = module.platform.api_fqdn }
output "web_fqdn" { value = module.platform.web_fqdn }
output "postgres_fqdn" { value = module.platform.postgres_fqdn }
