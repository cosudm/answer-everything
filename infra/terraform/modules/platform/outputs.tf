output "resource_group" { value = azurerm_resource_group.rg.name }
output "postgres_fqdn" { value = azurerm_postgresql_flexible_server.pg.fqdn }
output "key_vault_uri" { value = azurerm_key_vault.kv.vault_uri }
output "api_fqdn" { value = azurerm_container_app.api.latest_revision_fqdn }
output "web_fqdn" { value = azurerm_container_app.web.latest_revision_fqdn }
output "app_insights_connection_string" {
  value     = azurerm_application_insights.appi.connection_string
  sensitive = true
}
