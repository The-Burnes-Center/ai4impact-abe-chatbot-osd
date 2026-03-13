import { randomUUID, createHash } from "crypto";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });

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

async function getPromptVersion(promptFamily, versionId) {
  const tableName = process.env.PROMPT_REGISTRY_TABLE;
  if (!tableName) {
    return null;
  }

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
  };
}

async function bootstrapPrompt(promptFamily, basePrompt) {
  const tableName = process.env.PROMPT_REGISTRY_TABLE;
  if (!tableName) {
    return {
      versionId: "embedded-default",
      template: buildDefaultPromptTemplate(basePrompt),
    };
  }

  const versionId = `v-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const template = buildDefaultPromptTemplate(basePrompt);
  const now = new Date().toISOString();

  await ddbClient.send(new PutItemCommand({
    TableName: tableName,
    Item: {
      PromptFamily: { S: promptFamily },
      VersionId: { S: versionId },
      ItemType: { S: "PromptVersion" },
      Template: { S: template },
      Status: { S: "published" },
      Title: { S: "Default Runtime Prompt" },
      Notes: { S: "Bootstrapped from embedded default prompt." },
      CreatedAt: { S: now },
      UpdatedAt: { S: now },
      CreatedBy: { S: "system" },
    },
    ConditionExpression: "attribute_not_exists(PromptFamily) AND attribute_not_exists(VersionId)",
  })).catch(() => undefined);

  await ddbClient.send(new PutItemCommand({
    TableName: tableName,
    Item: {
      PromptFamily: { S: promptFamily },
      VersionId: { S: "LIVE" },
      ItemType: { S: "LivePointer" },
      ActiveVersionId: { S: versionId },
      Template: { S: versionId },
      UpdatedAt: { S: now },
    },
  })).catch(() => undefined);

  return {
    versionId,
    template,
  };
}

async function getLivePrompt(promptFamily, basePrompt) {
  const tableName = process.env.PROMPT_REGISTRY_TABLE;
  if (!tableName) {
    return {
      versionId: "embedded-default",
      template: buildDefaultPromptTemplate(basePrompt),
    };
  }

  const livePointer = await ddbClient.send(new GetItemCommand({
    TableName: tableName,
    Key: {
      PromptFamily: { S: promptFamily },
      VersionId: { S: "LIVE" },
    },
  }));

  const activeVersionId = livePointer.Item?.ActiveVersionId?.S || livePointer.Item?.Template?.S;
  if (!activeVersionId) {
    return bootstrapPrompt(promptFamily, basePrompt);
  }

  const version = await getPromptVersion(promptFamily, activeVersionId);
  if (!version) {
    return bootstrapPrompt(promptFamily, basePrompt);
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
    promptTemplateHash: createHash("sha256").update(livePrompt.template).digest("hex"),
    promptText,
  };
}
