#!/usr/bin/env bash
# Deploys the agent to Azure Container Apps with Azure Blob Storage for conversation history,
# then points the Azure Bot's messaging endpoint at it.
#
# Requirements: Azure CLI (az) logged in with `az login`, and the containerapp extension
#   (az extension add --name containerapp).
# Run from the repository root with these variables set (e.g. in .env):
#   clientId, clientSecret, tenantId, ANTHROPIC_API_KEY
#   BOT_NAME            name of the Azure Bot resource created in the setup guide
#   BOT_RESOURCE_GROUP  its resource group
# Optional: RESOURCE_GROUP, LOCATION, NAME_PREFIX
set -euo pipefail

if [[ -f .env ]]; then set -a; source .env; set +a; fi

: "${clientId:?Set clientId}" "${clientSecret:?Set clientSecret}" "${tenantId:?Set tenantId}"
: "${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY}" "${BOT_NAME:?Set BOT_NAME}" "${BOT_RESOURCE_GROUP:?Set BOT_RESOURCE_GROUP}"

RESOURCE_GROUP="${RESOURCE_GROUP:-teams-claude-agent}"
LOCATION="${LOCATION:-norwayeast}"
PREFIX="${NAME_PREFIX:-tca$(echo -n "$clientId" | tr -d '-' | cut -c1-8)}"
ACR="${PREFIX}acr"
STORAGE_ACCOUNT="${PREFIX}state"
ENVIRONMENT="${PREFIX}-env"
APP="${PREFIX}-app"
IMAGE="$ACR.azurecr.io/teams-claude-agent:$(date +%Y%m%d%H%M%S)"

echo "==> Resource group $RESOURCE_GROUP ($LOCATION)"
az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none

echo "==> Storage account for conversation history"
az storage account create -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" -l "$LOCATION" --sku Standard_LRS -o none
BLOB_CONNECTION_STRING=$(az storage account show-connection-string -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" -o tsv)
az storage container create -n teams-agent-state --connection-string "$BLOB_CONNECTION_STRING" -o none

echo "==> Container registry and image build (runs in Azure, no local Docker needed)"
az acr create -n "$ACR" -g "$RESOURCE_GROUP" -l "$LOCATION" --sku Basic --admin-enabled true -o none
az acr build -r "$ACR" -t "${IMAGE#*/}" .
ACR_PASSWORD=$(az acr credential show -n "$ACR" --query "passwords[0].value" -o tsv)

echo "==> Container Apps environment"
az containerapp env create -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" -l "$LOCATION" -o none

SECRETS=(
  "client-secret=$clientSecret"
  "anthropic-key=$ANTHROPIC_API_KEY"
  "blob-conn=$BLOB_CONNECTION_STRING"
)
ENV_VARS=(
  "clientId=$clientId"
  "tenantId=$tenantId"
  "clientSecret=secretref:client-secret"
  "ANTHROPIC_API_KEY=secretref:anthropic-key"
  "STORAGE_TYPE=blob"
  "BLOB_CONNECTION_STRING=secretref:blob-conn"
  "CLAUDE_MODEL=${CLAUDE_MODEL:-claude-opus-5-5}"
  "CLAUDE_EFFORT=${CLAUDE_EFFORT:-medium}"
)

echo "==> Container app $APP"
# One replica: turns in the same conversation are serialized in-process.
if az containerapp show -n "$APP" -g "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az containerapp secret set -n "$APP" -g "$RESOURCE_GROUP" --secrets "${SECRETS[@]}" -o none
  az containerapp update -n "$APP" -g "$RESOURCE_GROUP" --image "$IMAGE" --set-env-vars "${ENV_VARS[@]}" -o none
else
  az containerapp create -n "$APP" -g "$RESOURCE_GROUP" --environment "$ENVIRONMENT" \
    --image "$IMAGE" --registry-server "$ACR.azurecr.io" --registry-username "$ACR" --registry-password "$ACR_PASSWORD" \
    --target-port 3978 --ingress external --min-replicas 1 --max-replicas 1 --cpu 0.5 --memory 1.0Gi \
    --secrets "${SECRETS[@]}" --env-vars "${ENV_VARS[@]}" -o none
fi

FQDN=$(az containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)
ENDPOINT="https://$FQDN/api/messages"

echo "==> Pointing Azure Bot $BOT_NAME at $ENDPOINT"
az bot update -n "$BOT_NAME" -g "$BOT_RESOURCE_GROUP" --endpoint "$ENDPOINT" -o none

echo "Done. Messaging endpoint: $ENDPOINT"
