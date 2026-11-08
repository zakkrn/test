import { FileStorage, MemoryStorage, type Storage } from "@microsoft/agents-hosting";
import { BlobsStorage } from "@microsoft/agents-hosting-storage-blob";
import { CosmosDbPartitionedStorage } from "@microsoft/agents-hosting-storage-cosmos";

/**
 * Picks the storage backend from STORAGE_TYPE:
 * - "file"   (default) JSON files in STORAGE_FOLDER, survives restarts on one machine
 * - "blob"   Azure Blob Storage (BLOB_CONNECTION_STRING, BLOB_CONTAINER)
 * - "cosmos" Azure Cosmos DB (COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DATABASE, COSMOS_CONTAINER)
 * - "memory" in-memory only, lost on restart (tests)
 */
export function createStorage(): Storage {
  const type = (process.env.STORAGE_TYPE ?? "file").toLowerCase();

  switch (type) {
    case "memory":
      return new MemoryStorage();

    case "file":
      return new FileStorage(process.env.STORAGE_FOLDER ?? "./data");

    case "blob":
      return new BlobsStorage(
        process.env.BLOB_CONTAINER ?? "teams-agent-state",
        required("BLOB_CONNECTION_STRING"),
      );

    case "cosmos":
      return new CosmosDbPartitionedStorage({
        databaseId: process.env.COSMOS_DATABASE ?? "teams-agent",
        containerId: process.env.COSMOS_CONTAINER ?? "state",
        cosmosClientOptions: {
          endpoint: required("COSMOS_ENDPOINT"),
          key: required("COSMOS_KEY"),
        },
      });

    default:
      throw new Error(`Unknown STORAGE_TYPE "${type}". Use file, blob, cosmos or memory.`);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set when STORAGE_TYPE=${process.env.STORAGE_TYPE}`);
  return value;
}
