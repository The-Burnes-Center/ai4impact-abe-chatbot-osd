import { createHash } from "crypto";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

const SYSTEM_DEFAULT_VERSION_ID = "system-default";

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });

let _cachedHash = null;

function buildDefaultPromptTemplate(basePrompt) {
  return `${basePrompt}

### Current Date
Today is {{current_date}}. Use this to evaluate the recency and relevance of information in the retrieved documents.

###Metadata information:
{{metadata_json}}`;
}

function renderPromptTemplate(template, { currentDate, metadata }) {
  const metadataJson = JSON.stringify(metadata ?? {}, null, 2);
  return template
    .replaceAll("{{current_date}}", currentDate)
    .replaceAll("{{metadata_json}}", metadataJson);
}

function hashTemplate(template) {
  return createHash("sha256").update(template).digest("hex");
}

async function getPromptVersion(promptFamily, versionId) {
  const tableName = process.env.PROMPT_REGISTRY_TABLE;
  if (!tableName) return null;

  const response = await ddbClient.send(new GetItemCommand({
    TableName: tableName,
    Key: {
      PromptFamily: { S: promptFamily },
      VersionId: { S: versionId },
    },
  }));

  if (!response.Item || response.Item.ItemType?.S !== "PromptVersion") {
    return null;
  }

  return {
    versionId,
    template: response.Item.Template?.S ?? "",
    createdBy: response.Item.CreatedBy?.S ?? "",
  };
}

async function ensureSystemDefault(promptFamily, basePrompt) {
  const tableName = process.env.PROMPT_REGISTRY_TABLE;
  if (!tableName) return;

  const template = buildDefaultPromptTemplate(basePrompt);
  const currentHash = hashTemplate(template);

  if (_cachedHash === currentHash) return;

  const existing = await ddbClient.send(new GetItemCommand({
    TableName: tableName,
    Key: {
      PromptFamily: { S: promptFamily },
      VersionId: { S: SYSTEM_DEFAULT_VERSION_ID },
    },
  }));

  const storedHash = existing.Item?.TemplateHash?.S;

  if (storedHash !== currentHash) {
    const now = new Date().toISOString();
    await ddbClient.send(new PutItemCommand({
      TableName: tableName,
      Item: {
        PromptFamily: { S: promptFamily },
        VersionId: { S: SYSTEM_DEFAULT_VERSION_ID },
        ItemType: { S: "PromptVersion" },
        Template: { S: template },
        TemplateHash: { S: currentHash },
        Status: { S: "published" },
        Title: { S: "Code Default" },
        Notes: { S: "Auto-synced from code deployment. Read-only." },
        CreatedAt: { S: existing.Item?.CreatedAt?.S || now },
        UpdatedAt: { S: now },
        PublishedAt: { S: now },
        CreatedBy: { S: "system" },
      },
    }));
    console.log("System-default prompt updated (hash changed).");

    const livePointer = await ddbClient.send(new GetItemCommand({
      TableName: tableName,
      Key: {
        PromptFamily: { S: promptFamily },
        VersionId: { S: "LIVE" },
      },
    }));

    const activeVersionId = livePointer.Item?.ActiveVersionId?.S || livePointer.Item?.Template?.S;
    let shouldUpdateLive = false;

    if (!activeVersionId || activeVersionId === SYSTEM_DEFAULT_VERSION_ID) {
      shouldUpdateLive = true;
    } else {
      const activeVersion = await getPromptVersion(promptFamily, activeVersionId);
      if (!activeVersion || activeVersion.createdBy === "system") {
        shouldUpdateLive = true;
      }
    }

    if (shouldUpdateLive) {
      await ddbClient.send(new PutItemCommand({
        TableName: tableName,
        Item: {
          PromptFamily: { S: promptFamily },
          VersionId: { S: "LIVE" },
          ItemType: { S: "LivePointer" },
          ActiveVersionId: { S: SYSTEM_DEFAULT_VERSION_ID },
          Template: { S: SYSTEM_DEFAULT_VERSION_ID },
          UpdatedAt: { S: now },
        },
      }));
      console.log("LIVE pointer updated to system-default.");
    }
  }

  _cachedHash = currentHash;
}

async function getLivePrompt(promptFamily, basePrompt) {
  const tableName = process.env.PROMPT_REGISTRY_TABLE;
  if (!tableName) {
    return {
      versionId: "embedded-default",
      template: buildDefaultPromptTemplate(basePrompt),
    };
  }

  await ensureSystemDefault(promptFamily, basePrompt);

  const livePointer = await ddbClient.send(new GetItemCommand({
    TableName: tableName,
    Key: {
      PromptFamily: { S: promptFamily },
      VersionId: { S: "LIVE" },
    },
  }));

  const activeVersionId = livePointer.Item?.ActiveVersionId?.S || livePointer.Item?.Template?.S;
  if (!activeVersionId) {
    return {
      versionId: SYSTEM_DEFAULT_VERSION_ID,
      template: buildDefaultPromptTemplate(basePrompt),
    };
  }

  const version = await getPromptVersion(promptFamily, activeVersionId);
  if (!version) {
    return {
      versionId: SYSTEM_DEFAULT_VERSION_ID,
      template: buildDefaultPromptTemplate(basePrompt),
    };
  }

  return version;
}

export async function loadRenderedPrompt(basePrompt, metadata, currentDate) {
  const promptFamily = process.env.PROMPT_FAMILY || "ABE_CHAT";
  const livePrompt = await getLivePrompt(promptFamily, basePrompt);
  const promptText = renderPromptTemplate(livePrompt.template, {
    currentDate,
    metadata,
  });

  return {
    promptVersionId: livePrompt.versionId,
    promptTemplateHash: hashTemplate(livePrompt.template),
    promptText,
  };
}
