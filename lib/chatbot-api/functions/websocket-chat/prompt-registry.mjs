/**
 * @module prompt-registry
 *
 * Versioned prompt management with a DynamoDB-backed registry.
 *
 * ## Purpose
 * Allows the system prompt to be edited by admins through the UI without
 * redeploying. The code-embedded prompt (in prompt.mjs) is treated as the
 * "system-default" version. Admins can create custom versions in DynamoDB;
 * a special LIVE pointer row determines which version is actually served.
 *
 * ## LIVE pointer indirection
 * The registry uses a two-level lookup:
 *   1. Read the LIVE row (`VersionId = "LIVE"`) for the prompt family.
 *      Its `ActiveVersionId` field names the version that should be used.
 *   2. Fetch that version row to get the actual template text.
 *
 * This indirection lets admins switch the active prompt atomically (update
 * one DynamoDB item) without touching the version rows themselves.
 *
 * ## SHA-256 hash-based change detection
 * Each version row stores a `TemplateHash` (SHA-256 of the template text).
 * On every cold/warm start, `ensureSystemDefault` compares the hash of the
 * code-embedded prompt against the stored hash. If they differ (i.e. a new
 * deployment changed the prompt), the system-default row is overwritten and
 * the LIVE pointer is updated -- but only when no admin-created version is
 * active (see "custom version preservation" below). A module-level cache
 * (`_cachedHash`) skips the DynamoDB read entirely when the hash has not
 * changed within the same Lambda execution context.
 *
 * ## Fallback chain
 *   Registry LIVE pointer -> referenced version row -> embedded default
 * If `PROMPT_REGISTRY_TABLE` is not set, or if the LIVE pointer / version
 * row is missing, the module falls back to the code-embedded default
 * template so the chatbot always has a working system prompt.
 *
 * ## Custom version preservation
 * When the LIVE pointer references a version whose `CreatedBy` is NOT
 * "system", the pointer is left untouched during `ensureSystemDefault`.
 * This prevents a routine deployment from overriding an admin's deliberate
 * prompt edit. Only system-created versions are auto-promoted.
 */

import { createHash } from "crypto";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

/** Well-known VersionId for the code-embedded default prompt row. */
const SYSTEM_DEFAULT_VERSION_ID = "system-default";

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });

/**
 * Module-level in-memory cache of the last-written template hash.
 * Prevents redundant DynamoDB reads within a single Lambda execution
 * context when the code-embedded prompt has not changed.
 * @type {string|null}
 */
let _cachedHash = null;

/**
 * Wrap the raw base prompt with the standard variable placeholders.
 *
 * Appends `{{current_date}}` and `{{metadata_json}}` sections so that
 * {@link renderPromptTemplate} can inject runtime values later.
 *
 * @param {string} basePrompt - The raw system prompt exported by prompt.mjs.
 * @returns {string} Template string containing mustache-style placeholders.
 */
function buildDefaultPromptTemplate(basePrompt) {
  return `${basePrompt}

### Current Date
Today is {{current_date}}. Use this to evaluate the recency and relevance of information in the retrieved documents.

###Metadata information:
{{metadata_json}}`;
}

/**
 * Replace mustache-style placeholders in a prompt template with runtime values.
 *
 * @param {string} template - Template containing `{{current_date}}` and
 *   `{{metadata_json}}` placeholders.
 * @param {object} params
 * @param {string} params.currentDate - Human-readable date string.
 * @param {object} [params.metadata] - Arbitrary metadata object; serialized
 *   as pretty-printed JSON into the prompt.
 * @returns {string} Fully rendered prompt text ready for Bedrock.
 */
function renderPromptTemplate(template, { currentDate, metadata }) {
  const metadataJson = JSON.stringify(metadata ?? {}, null, 2);
  return template
    .replaceAll("{{current_date}}", currentDate)
    .replaceAll("{{metadata_json}}", metadataJson);
}

/**
 * Compute a SHA-256 hex digest of a template string.
 * Used for change detection between code-embedded and stored versions.
 *
 * @param {string} template
 * @returns {string} 64-character lowercase hex hash.
 */
function hashTemplate(template) {
  return createHash("sha256").update(template).digest("hex");
}

/**
 * Fetch a single prompt version row from DynamoDB.
 *
 * @param {string} promptFamily - Partition key (e.g. "ABE_CHAT").
 * @param {string} versionId - Sort key identifying the version.
 * @returns {Promise<{versionId: string, template: string, createdBy: string}|null>}
 *   The version record, or null if it does not exist or is not a PromptVersion.
 */
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

/**
 * Upsert the "system-default" version row and conditionally update the
 * LIVE pointer.
 *
 * Called on every prompt load. The function:
 *   1. Builds the default template from the code-embedded base prompt.
 *   2. Hashes it and compares against `_cachedHash` (fast in-memory check).
 *   3. If the hash differs, reads the stored row and compares hashes.
 *   4. On mismatch, writes the new template + hash to the system-default row.
 *   5. Reads the LIVE pointer to decide whether to redirect it:
 *      - If LIVE points to nothing, or to "system-default", update it.
 *      - If LIVE points to another version created by "system", update it.
 *      - If LIVE points to a version created by an admin (createdBy != "system"),
 *        leave it alone -- the admin's choice takes precedence.
 *
 * @param {string} promptFamily - Partition key (e.g. "ABE_CHAT").
 * @param {string} basePrompt - Raw prompt text from prompt.mjs.
 */
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

/**
 * Resolve the currently active prompt template via the LIVE pointer.
 *
 * Implements the full fallback chain:
 *   1. If `PROMPT_REGISTRY_TABLE` is not set, return the embedded default.
 *   2. Call {@link ensureSystemDefault} to sync the code-embedded prompt.
 *   3. Read the LIVE pointer's `ActiveVersionId`.
 *   4. Fetch the referenced version. If missing, fall back to the default.
 *
 * @param {string} promptFamily - Partition key (e.g. "ABE_CHAT").
 * @param {string} basePrompt - Raw prompt text from prompt.mjs (used as
 *   fallback and for syncing the system-default row).
 * @returns {Promise<{versionId: string, template: string}>}
 */
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

/**
 * Public entry point: load, render, and return the active system prompt.
 *
 * Orchestrates the full pipeline:
 *   1. Resolve the live prompt template from the registry (or fallback).
 *   2. Render placeholders (`{{current_date}}`, `{{metadata_json}}`).
 *   3. Return the final text plus version metadata for logging/tracing.
 *
 * @param {string} basePrompt - Raw prompt from prompt.mjs.
 * @param {object} metadata - Runtime metadata object (injected into the prompt).
 * @param {string} currentDate - Human-readable date string.
 * @returns {Promise<{promptVersionId: string, promptTemplateHash: string, promptText: string}>}
 *   `promptVersionId` identifies which version was served (useful for
 *   evaluation tracing). `promptTemplateHash` enables downstream
 *   cache-invalidation checks. `promptText` is the fully rendered string
 *   passed to Bedrock as the system message.
 */
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
