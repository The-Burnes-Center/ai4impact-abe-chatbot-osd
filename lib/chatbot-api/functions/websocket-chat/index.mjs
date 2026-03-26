import { ApiGatewayManagementApiClient, PostToConnectionCommand, DeleteConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { BedrockAgentRuntimeClient, RetrieveCommand as KBRetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
import ClaudeModel from "./models/chat-model.mjs";
import { PROMPT } from './prompt.mjs';
import { loadRenderedPrompt } from './prompt-registry.mjs';
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";



/*global fetch*/

const ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT;
const wsConnectionClient = new ApiGatewayManagementApiClient({ endpoint: ENDPOINT });

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const lambdaClient = new LambdaClient({});

// Static tools that don't depend on Excel schemas
const STATIC_TOOLS = [
  {
    "name": "query_db",
    "description": "Query a vector database for any information in your knowledge base. Try to use specific key words when possible.",
    "input_schema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "The query you want to make to the vector database."
        }
      },
      "required": ["query"]
    }
  },
  {
    "name": "retrieve_full_document",
    "description": "Retrieve the COMPLETE content of a specific document from the knowledge base by filename. Use this to get an entire Contract User Guide (CUG) or policy document when you need comprehensive contract details — not just snippets. Call this after an initial query_db search reveals which document is relevant. Returns ALL chunks of the document in page order with no truncation.",
    "input_schema": {
      "type": "object",
      "properties": {
        "document_name": {
          "type": "string",
          "description": "The filename (or partial filename) of the document to retrieve, e.g. 'FAC115' or 'FAC115 CUG.pdf'. Matched against the S3 URI."
        },
        "query_context": {
          "type": "string",
          "description": "Optional: what the user is asking about. Used as the retrieval query to help rank chunks by relevance."
        }
      },
      "required": ["document_name"]
    }
  },
  {
    "name": "fetch_metadata",
    "description": "Retrieve all metadata information from metadata.txt in the same knowledge bucket. Returns summaries and tags for every document in the knowledge base.",
    "input_schema": {
      "type": "object",
      "properties": {
        "reason": {
          "type": "string",
          "description": "Brief reason for fetching metadata (for logging)."
        }
      },
      "required": []
    }
  },
];

function cleanExcerptText(raw, maxLen) {
  let text = raw
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\.{3,}/g, "...")
    .replace(/\u2022/g, "- ")
    .replace(/\u00a0/g, " ")
    .trim();

  if (text.length > maxLen) {
    text = text.substring(0, maxLen);
    const lastSpace = text.lastIndexOf(" ");
    if (lastSpace > maxLen * 0.7) {
      text = text.substring(0, lastSpace);
    }
    text += "...";
  }
  return text;
}

/**
 * Convert native citation objects into [N] markers and mark sources as cited.
 * Citations arrive as { textOffset, citation: { document_index, ... } }.
 * We insert [N] (where N = chunkIndex) at each citation offset, processing
 * in reverse order so earlier offsets aren't shifted by insertions.
 */
function insertCitationMarkers(text, citations, docIndexMap, allSources) {
  if (!citations || citations.length === 0) return text;

  const citedChunkIndices = new Set();
  const sorted = [...citations].sort((a, b) => b.textOffset - a.textOffset);

  for (const { textOffset, citation } of sorted) {
    const docIdx = citation.document_index;
    const source = docIndexMap[docIdx];
    if (source && source.chunkIndex != null) {
      citedChunkIndices.add(source.chunkIndex);
      const marker = `[${source.chunkIndex}]`;
      text = text.slice(0, textOffset) + marker + text.slice(textOffset);
    }
  }

  for (const src of allSources) {
    src.cited = src.chunkIndex != null && citedChunkIndices.has(src.chunkIndex);
  }

  return text;
}

/**
 * Fallback: validate self-managed [N] markers when native citations aren't available.
 * Strips any [N] that doesn't correspond to a real source.
 */
function validateSelfManagedCitations(text, allSources) {
  const validIndices = new Set(
    allSources.map(s => s.chunkIndex).filter(i => i != null)
  );
  const cleaned = text.replace(/\[(\d+)\]/g, (match, num) => {
    return validIndices.has(parseInt(num, 10)) ? match : '';
  });
  const citedIndices = new Set();
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    citedIndices.add(parseInt(m[1], 10));
  }
  for (const src of allSources) {
    src.cited = src.chunkIndex != null && citedIndices.has(src.chunkIndex);
  }
  return cleaned;
}

/**
 * Load index metadata from the Index Registry DynamoDB table.
 * Called once at cold-start; cached for the Lambda instance lifetime.
 */
async function loadIndexMetadata() {
  const registryTable = process.env.INDEX_REGISTRY_TABLE;
  if (!registryTable) {
    console.warn("INDEX_REGISTRY_TABLE not set; no index metadata will be loaded.");
    return [];
  }
  try {
    const resp = await ddbClient.send(new QueryCommand({
      TableName: registryTable,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: "TOOLS" } },
    }));
    const indexes = [];
    for (const item of resp.Items || []) {
      const indexName = item.index_name?.S || item.sk?.S;
      const displayName = item.display_name?.S || indexName;
      const columns = (item.columns?.L || []).map(c => c.S || "");
      const rowCount = parseInt(item.row_count?.N || "0", 10);
      if (!indexName) continue;
      const description = item.description?.S || "";
      indexes.push({ index_name: indexName, display_name: displayName, description, columns, row_count: rowCount });
    }
    console.log(`Loaded metadata for ${indexes.length} index(es) from registry.`);
    return indexes;
  } catch (error) {
    console.error("Failed to load index metadata from registry:", error);
    return [];
  }
}

/**
 * Build a single query_excel_index tool definition from registry metadata.
 */
function buildExcelIndexTool(indexes) {
  if (indexes.length === 0) return null;
  const indexDescriptions = indexes.map((idx, i) => {
    const desc = idx.description ? ` — ${idx.description}` : "";
    return `${i + 1}. ${idx.index_name} — ${idx.display_name} (${idx.row_count} rows).${desc} Columns: ${idx.columns.join(", ")}`;
  }).join("\n");
  const enumValues = indexes.map(idx => idx.index_name);
  return {
    name: "query_excel_index",
    description: `Query structured Excel-based data indexes. Available indexes:\n\n${indexDescriptions}\n\nUse free_text for broad search across all columns. Use filters for column-specific matching (keys are exact column names from above). Matching is punctuation-insensitive.\n\nResponse fields: total_matches (row count), returned (rows in response), offset (starting position), rows (array of row objects). When count_unique is set, response also includes unique_count and unique_column. When group_by is set, response includes groups (object mapping each value to its count). When group_by and group_by_value_max are both set, response also includes group_max_values (max value of that column per group) and group_by_value_max_column. When distinct_values is set, response includes distinct_values (sorted list of unique values), distinct_column, and distinct_count. When min_value or max_value is set, response includes min/max objects with column and value. Date-filtered queries may include _entity_summary (server-added): distinct_entity_count, rows_per_entity, and optional max_value_per_entity — use these so the first answer states entity count vs row count correctly.\n\nIMPORTANT RULES:\n- total_matches counts ROWS, not distinct entities. NEVER count items yourself from returned rows — ALWAYS use count_unique or group_by to get accurate counts.\n- For ANY question involving counts or "how many", use count_only, count_unique, or group_by FIRST before fetching row data.\n- ALWAYS specify "columns" with only the fields needed to answer the question. Returning all columns wastes context and may cause errors.\n- If a result includes "_truncated": true, not all rows were returned. Use count_unique/group_by for totals, or paginate with offset.\n- For date-based questions (expired, expiring soon, valid contracts), use date_before/date_after to filter on date columns server-side. NEVER scan all rows and compare dates yourself. Example: to find expired contracts, use date_before: {"Master_Blanket_Contract_EndDate": "2026-03-23"} with today's date.\n- Use sort_by to order results by any column (dates, names, etc.) and sort_order for direction. Example: sort_by: "Master_Blanket_Contract_EndDate", sort_order: "asc" for soonest-expiring first.\n- Use distinct_values to list all unique values in a column. Use min_value/max_value to find the earliest/latest date or smallest/largest value.\n\nPagination: default limit is 50 rows. If total_matches > returned + offset, use offset to fetch the next page. Use limit up to 500 only when the user explicitly asks for a complete list.`,
    input_schema: {
      type: "object",
      properties: {
        index_name: { type: "string", enum: enumValues, description: "Which index to query." },
        free_text: { type: "string", description: "Search across all columns (punctuation-insensitive partial match)." },
        filters: { type: "object", description: "Column-specific filters as {column_name: search_value}. Use exact column names from the index description." },
        date_before: { type: "object", description: "Date range filter: {column_name: \"YYYY-MM-DD\"}. Returns only rows where the column's date is BEFORE the given date (exclusive). Use for finding expired/past items." },
        date_after: { type: "object", description: "Date range filter: {column_name: \"YYYY-MM-DD\"}. Returns only rows where the column's date is AFTER the given date (exclusive). Use for finding future/upcoming items." },
        columns: { type: "array", items: { type: "string" }, description: "Column names to include in each returned row. ALWAYS specify this — include only fields relevant to the question." },
        count_only: { type: "boolean", description: "If true, return only total counts, no row data. Use for 'how many' questions." },
        count_unique: { type: "string", description: "Column name to count distinct values for. Returns unique_count. Use for 'how many unique X' questions." },
        group_by: { type: "string", description: "Column name to group and count by. Returns groups object {value: count}. Use for breakdowns like 'how many per severity/state/category'. Can combine with filters." },
        group_by_value_max: { type: "string", description: "Optional column (e.g. end date) — requires group_by. Returns group_max_values: max value of this column per group. Use with group_by for per-entity latest date." },
        distinct_values: { type: "string", description: "Column name to list all unique values for. Returns distinct_values (sorted array), distinct_column, and distinct_count. Use for 'what are all the X?' questions." },
        min_value: { type: "string", description: "Column name to find the minimum value for. Returns min object {column, value}. Works with dates and numbers." },
        max_value: { type: "string", description: "Column name to find the maximum value for. Returns max object {column, value}. Works with dates and numbers." },
        sort_by: { type: "string", description: "Column name to sort results by. Works with dates, numbers, and text. Combine with sort_order." },
        sort_order: { type: "string", enum: ["asc", "desc"], description: "Sort direction: 'asc' (default) for ascending, 'desc' for descending." },
        limit: { type: "integer", description: "Max rows to return (default 50, max 500). Use 50 or fewer unless the user explicitly asks for a full list.", default: 50 },
        offset: { type: "integer", description: "Number of matching rows to skip before collecting results. Use for pagination (e.g. offset=100 for the second page of 100).", default: 0 },
      },
      required: ["index_name"],
    },
  };
}

function truncate(str, max = 60) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "\u2026" : str;
}

const MAX_ESTIMATED_TOKENS = 160000;
const COMPRESSION_THRESHOLD = 120000;

function estimateTokens(systemPrompt, history, tools) {
  const chars = systemPrompt.length + JSON.stringify(history).length + JSON.stringify(tools).length;
  return Math.ceil(chars / 3.5);
}

/**
 * Compress older conversation history by summarizing it via the context-summarizer Lambda.
 * Keeps the most recent 2 exchange pairs (4 messages) verbatim for immediate context.
 * Returns { compressedHistory, summaryText } or null if not enough history to compress.
 */
async function summarizeHistory(history, connectionId) {
  // Send a neutral status so the user sees the thinking indicator
  try {
    await wsConnectionClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: "!<|STATUS|>!Thinking\u2026"
    }));
  } catch (statusErr) {
    console.warn("Status send failed:", statusErr);
  }

  // Keep the last 4 messages (2 user/assistant pairs) intact
  const toSummarize = history.slice(0, -4);
  const toKeep = history.slice(-4);

  if (toSummarize.length < 2) {
    return null;
  }

  // Build text representation of older messages for the summarizer
  const conversationText = toSummarize.map(msg => {
    const text = Array.isArray(msg.content)
      ? msg.content.map(b => b.text || b.source?.data || "").join(" ")
      : String(msg.content);
    return `${msg.role}: ${text}`;
  }).join("\n\n");

  const payload = JSON.stringify({ conversation_text: conversationText });
  const command = new InvokeCommand({
    FunctionName: process.env.CONTEXT_SUMMARIZER_FUNCTION,
    Payload: Buffer.from(payload),
  });
  const response = await lambdaClient.send(command);
  const result = JSON.parse(Buffer.from(response.Payload).toString());

  if (result.statusCode !== 200) {
    throw new Error(`Context summarizer returned ${result.statusCode}: ${result.body}`);
  }

  const body = JSON.parse(result.body);
  const summaryText = body.summary_text;

  const compressedHistory = [
    { role: "user", content: [{ type: "text", text: `[CONVERSATION SUMMARY]\n${summaryText}` }] },
    { role: "assistant", content: [{ type: "text", text: "Understood. I have the context from our earlier conversation and will continue naturally." }] },
    ...toKeep
  ];

  return { compressedHistory, summaryText };
}

const MAX_TOOL_RESULT_CHARS = 60000;

/**
 * Cap a serialized tool-result string so it doesn't blow the context window.
 * If the JSON is over budget, truncate the `rows` array to fit and append a
 * note so the model knows the data is partial.
 */
function capToolResultSize(resultStr) {
  if (typeof resultStr !== "string" || resultStr.length <= MAX_TOOL_RESULT_CHARS) {
    return resultStr;
  }
  try {
    const data = JSON.parse(resultStr);
    if (!Array.isArray(data.rows) || data.rows.length === 0) return resultStr;

    let lo = 0, hi = data.rows.length, best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const trial = JSON.stringify({ ...data, rows: data.rows.slice(0, mid), returned: mid });
      if (trial.length <= MAX_TOOL_RESULT_CHARS - 200) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    data.rows = data.rows.slice(0, best);
    data.returned = best;
    data._truncated = true;
    data._note = `Only ${best} of ${data.total_matches} rows shown (result too large). ` +
      `Use count_unique, group_by, or narrower filters for complete analysis. ` +
      `Use offset=${best} to fetch the next page.`;
    return JSON.stringify(data);
  } catch (_) {
    return resultStr.slice(0, MAX_TOOL_RESULT_CHARS);
  }
}

/** Build the full tools array fresh from registry (called per-request). */
async function getAllTools() {
  const indexes = await loadIndexMetadata();
  const excelTool = buildExcelIndexTool(indexes);
  const tools = [...STATIC_TOOLS, ...(excelTool ? [excelTool] : [])];
  console.log(`Tools for request: ${tools.length} (${STATIC_TOOLS.length} static + ${excelTool ? 1 : 0} dynamic)`);
  return { tools, indexes };
}

const fetchMetadata = async () => {
  const payload = JSON.stringify({});
  try {
    const command = new InvokeCommand({
      FunctionName: process.env.METADATA_RETRIEVAL_FUNCTION,
      Payload: Buffer.from(payload),
    });
    const response = await lambdaClient.send(command);

    // Parse the response payload
    const parsedPayload = JSON.parse(Buffer.from(response.Payload).toString());
    console.log("Parsed Result:", parsedPayload);
        // Extract metadata from the body field
    const metadata = JSON.parse(parsedPayload.body).metadata;
    console.log("Extracted Metadata:", metadata);

    return metadata;
  } catch (error) {
    console.error("Error fetching metadata:", error);
    return null;
  }
};

function pickEntityIdColumn(columns) {
  if (!Array.isArray(columns) || columns.length === 0) return null;
  const preferred = ["Contract_ID", "contract_id", "ContractId"];
  for (const p of preferred) {
    if (columns.includes(p)) return p;
  }
  const found = columns.find((c) =>
    /^contract[_\s]?id$/i.test(String(c).trim().replace(/\s+/g, "_"))
  );
  return found || null;
}

function pickDateColumnFromQuery(query) {
  if (query.date_before && typeof query.date_before === "object" && !Array.isArray(query.date_before)) {
    const keys = Object.keys(query.date_before);
    if (keys.length) return keys[0];
  }
  if (query.date_after && typeof query.date_after === "object" && !Array.isArray(query.date_after)) {
    const keys = Object.keys(query.date_after);
    if (keys.length) return keys[0];
  }
  return null;
}

function excelQueryNeedsEntitySummaryEnrichment(query) {
  const db = query.date_before && typeof query.date_before === "object" ? Object.keys(query.date_before).length : 0;
  const da = query.date_after && typeof query.date_after === "object" ? Object.keys(query.date_after).length : 0;
  if (db === 0 && da === 0) return false;
  if (query.count_unique) return false;
  if (query.group_by) return false;
  if (query.distinct_values) return false;
  return true;
}

/**
 * After a date-filtered Excel query, attach distinct entity counts and per-entity row counts
 * (and max date per entity when the filter column is known) without requiring a follow-up tool call.
 */
async function enrichExcelIndexResult(query, indexName, toolResultStr, idxMeta) {
  if (typeof toolResultStr !== "string") return toolResultStr;
  if (!excelQueryNeedsEntitySummaryEnrichment(query)) return toolResultStr;
  const entityCol = pickEntityIdColumn(idxMeta?.columns);
  if (!entityCol) return toolResultStr;
  let parsed;
  try {
    parsed = JSON.parse(toolResultStr);
  } catch {
    return toolResultStr;
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.total_matches !== "number") {
    return toolResultStr;
  }
  if (parsed.total_matches <= 0) return toolResultStr;

  const dateCol = pickDateColumnFromQuery(query);
  const enrichPayload = {
    action: "query",
    index_name: indexName,
    free_text: query.free_text || null,
    filters: query.filters || null,
    date_before: query.date_before || null,
    date_after: query.date_after || null,
    count_only: true,
    count_unique: entityCol,
    group_by: entityCol,
    ...(dateCol ? { group_by_value_max: dateCol } : {}),
    limit: typeof query.limit === "number" ? query.limit : 100,
    offset: 0,
  };
  const enrichStr = await invokeIndexQuery(enrichPayload);
  let enrichParsed;
  try {
    enrichParsed = JSON.parse(enrichStr);
  } catch {
    return toolResultStr;
  }
  if (typeof enrichParsed !== "object" || enrichParsed === null || enrichParsed.error) {
    return toolResultStr;
  }

  parsed._entity_summary = {
    entity_id_column: entityCol,
    distinct_entity_count: enrichParsed.unique_count,
    row_total_matches: parsed.total_matches,
    rows_per_entity: enrichParsed.groups || {},
    ...(enrichParsed.group_max_values
      ? {
          max_value_per_entity: enrichParsed.group_max_values,
          value_column: enrichParsed.group_by_value_max_column,
        }
      : {}),
    note:
      "row_total_matches counts ROWS; distinct_entity_count counts unique entity_id_column values. Never report row count as the number of contracts/entities.",
  };
  return JSON.stringify(parsed);
}

/** Invoke the generic Excel index query Lambda; returns string content for agent. */
async function invokeIndexQuery(payload) {
  const fnName = process.env.EXCEL_INDEX_QUERY_FUNCTION;
  if (!fnName) {
    return "Index query Lambda is not configured.";
  }
  try {
    const command = new InvokeCommand({
      FunctionName: fnName,
      Payload: Buffer.from(JSON.stringify(payload)),
      InvocationType: "RequestResponse",
    });
    const response = await lambdaClient.send(command);
    const raw = response.Payload ? Buffer.from(response.Payload).toString() : "{}";
    const parsed = JSON.parse(raw);
    const statusCode = parsed.statusCode ?? 500;
    const body = typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body ?? {});
    if (statusCode !== 200) {
      const err = JSON.parse(body);
      return err.error || "Index query failed.";
    }
    return body;
  } catch (error) {
    console.error("Index query error:", error);
    return "Could not query the index. Please try again or rephrase.";
  }
}

async function constructSysPrompt() {
  const metadata = await fetchMetadata();
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York'
  });
  const rendered = await loadRenderedPrompt(PROMPT, metadata, dateStr);
  return {
    metadata,
    promptVersionId: rendered.promptVersionId,
    promptTemplateHash: rendered.promptTemplateHash,
    promptText: rendered.promptText,
  };
}

async function writeResponseTrace({
  messageId,
  sessionId,
  turnIndex,
  userPrompt,
  finalAnswer,
  sources,
  promptVersionId,
  promptTemplateHash,
  modelId,
  guardrailId,
}) {
  const tableName = process.env.RESPONSE_TRACE_TABLE;
  if (!tableName) {
    return;
  }

  const createdAt = new Date().toISOString();
  await ddbClient.send(new PutItemCommand({
    TableName: tableName,
    Item: {
      MessageId: { S: messageId },
      SessionId: { S: sessionId },
      CreatedAt: { S: createdAt },
      TurnIndex: { N: String(turnIndex) },
      UserPrompt: { S: userPrompt },
      FinalAnswer: { S: finalAnswer || "" },
      Sources: { S: JSON.stringify(sources || []) },
      RetrievalSnapshot: { S: JSON.stringify({ sources: sources || [] }) },
      PromptVersionId: { S: promptVersionId || "embedded-default" },
      PromptTemplateHash: { S: promptTemplateHash || "" },
      ModelId: { S: modelId || process.env.PRIMARY_MODEL_ID || "" },
      GuardrailId: { S: guardrailId || "" },
      TraceSummary: { S: JSON.stringify({
        sourceCount: Array.isArray(sources) ? sources.length : 0,
      }) },
    },
  }));
}

const s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

const CONTENT_TYPE_MAP = {
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function retrieveKBDocs(query, knowledgeBase, knowledgeBaseID, startIndex = 0) {
  const input = {
    knowledgeBaseId: knowledgeBaseID,
    retrievalQuery: { text: query },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: 25,
      },
    },
  };

  try {
    const command = new KBRetrieveCommand(input);
    const response = await knowledgeBase.send(command);

    // Fetch one additional page if available for broader coverage
    let allResults = response.retrievalResults || [];
    if (response.nextToken) {
      try {
        const page2 = await knowledgeBase.send(new KBRetrieveCommand({
          ...input,
          nextToken: response.nextToken,
        }));
        if (page2.retrievalResults) {
          allResults = allResults.concat(page2.retrievalResults);
        }
      } catch (page2Err) {
        console.warn("KB pagination page 2 failed:", page2Err);
      }
    }

    const confidenceFilteredResults = allResults.filter(item =>
      item.score > 0.3
    );

    if (confidenceFilteredResults.length === 0) {
      console.log("Warning: no relevant sources found");
      return {
        content: `No knowledge available! This query is likely outside the scope of your knowledge.
      Please provide a general answer but do not attempt to provide specific details.`,
        sources: [],
        documentBlocks: []
      };
    }

    // Cache pre-signed URLs by S3 key to avoid redundant signing for chunks from the same doc
    const signedUrlCache = new Map();

    const sources = await Promise.all(
      confidenceFilteredResults.map(async (item, i) => {
        const s3Uri = item.location.s3Location.uri;
        const bucketName = s3Uri.split("/")[2];
        const objectKey = s3Uri.split("/").slice(3).join("/");
        const fileName = objectKey.split("/").pop() || objectKey;

        let signedUrl = signedUrlCache.get(s3Uri);
        if (!signedUrl) {
          const ext = objectKey.split(".").pop()?.toLowerCase() || "";
          const contentType = CONTENT_TYPE_MAP[ext] || "application/octet-stream";
          signedUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
              Bucket: bucketName,
              Key: objectKey,
              ResponseContentDisposition: "inline",
              ResponseContentType: contentType,
            }),
            { expiresIn: 3600 }
          );
          signedUrlCache.set(s3Uri, signedUrl);
        }

        const chunkText = item.content.text;
        const pageNum = item.metadata?.["x-amz-bedrock-kb-document-page-number"] ?? null;
        const cleanedExcerpt = cleanExcerptText(chunkText, 300);

        return {
          chunkIndex: startIndex + i + 1,
          title: fileName,
          uri: signedUrl,
          excerpt: cleanedExcerpt,
          score: Math.round(item.score * 100) / 100,
          page: pageNum,
          s3Key: objectKey,
          sourceType: "knowledgeBase"
        };
      })
    );

    const documentBlocks = confidenceFilteredResults.map((item, i) => {
      const fileName = item.location.s3Location.uri.split("/").pop() || "document";
      const pageNum = item.metadata?.["x-amz-bedrock-kb-document-page-number"] ?? null;
      const sourceNum = startIndex + i + 1;
      return {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: item.content.text },
        title: `Source ${sourceNum} - ${fileName}`,
        context: `Page ${pageNum || "N/A"}, relevance score ${item.score}`,
        citations: { enabled: true }
      };
    });

    return {
      content: "",
      sources: sources,
      documentBlocks
    };
  } catch (error) {
    console.error("Caught error: could not retrieve Knowledge Base documents:", error);
    return {
      content: `No knowledge available! There is something wrong with the search tool. Please tell the user to submit feedback.
      Please provide a general answer but do not attempt to provide specific details.`,
      sources: [],
      documentBlocks: []
    };
  }
}

/**
 * Retrieve ALL chunks of a specific document from the KB by filename.
 * Uses x-amz-bedrock-kb-source-uri metadata filter + nextToken pagination
 * so the model gets the complete document with no truncation.
 */
async function retrieveFullDocument(documentName, knowledgeBase, knowledgeBaseID, queryContext, startIndex = 0) {
  const retrievalQuery = queryContext || documentName;
  const allResults = [];
  let nextToken = undefined;

  try {
    do {
      const input = {
        knowledgeBaseId: knowledgeBaseID,
        retrievalQuery: { text: retrievalQuery },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 100,
            filter: {
              stringContains: {
                key: "x-amz-bedrock-kb-source-uri",
                value: documentName,
              },
            },
          },
        },
        ...(nextToken ? { nextToken } : {}),
      };
      const command = new KBRetrieveCommand(input);
      const response = await knowledgeBase.send(command);
      if (response.retrievalResults) {
        allResults.push(...response.retrievalResults);
      }
      nextToken = response.nextToken;
    } while (nextToken);

    if (allResults.length === 0) {
      console.log(`retrieve_full_document: no chunks found for "${documentName}"`);
      return {
        content: `No document found matching "${documentName}" in the knowledge base.`,
        sources: [],
        documentBlocks: [],
      };
    }

    // Sort by page number when available
    allResults.sort((a, b) => {
      const pageA = a.metadata?.["x-amz-bedrock-kb-document-page-number"] ?? 0;
      const pageB = b.metadata?.["x-amz-bedrock-kb-document-page-number"] ?? 0;
      return pageA - pageB;
    });

    console.log(`retrieve_full_document: collected ${allResults.length} chunks for "${documentName}"`);

    const signedUrlCache = new Map();

    const sources = await Promise.all(
      allResults.map(async (item, i) => {
        const s3Uri = item.location.s3Location.uri;
        const bucketName = s3Uri.split("/")[2];
        const objectKey = s3Uri.split("/").slice(3).join("/");
        const fileName = objectKey.split("/").pop() || objectKey;

        let signedUrl = signedUrlCache.get(s3Uri);
        if (!signedUrl) {
          const ext = objectKey.split(".").pop()?.toLowerCase() || "";
          const contentType = CONTENT_TYPE_MAP[ext] || "application/octet-stream";
          signedUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
              Bucket: bucketName,
              Key: objectKey,
              ResponseContentDisposition: "inline",
              ResponseContentType: contentType,
            }),
            { expiresIn: 3600 }
          );
          signedUrlCache.set(s3Uri, signedUrl);
        }

        const chunkText = item.content.text;
        const pageNum = item.metadata?.["x-amz-bedrock-kb-document-page-number"] ?? null;
        const cleanedExcerpt = cleanExcerptText(chunkText, 300);

        return {
          chunkIndex: startIndex + i + 1,
          title: fileName,
          uri: signedUrl,
          excerpt: cleanedExcerpt,
          score: item.score != null ? Math.round(item.score * 100) / 100 : null,
          page: pageNum,
          s3Key: objectKey,
          sourceType: "knowledgeBase",
        };
      })
    );

    const documentBlocks = allResults.map((item, i) => {
      const fileName = item.location.s3Location.uri.split("/").pop() || "document";
      const pageNum = item.metadata?.["x-amz-bedrock-kb-document-page-number"] ?? null;
      const sourceNum = startIndex + i + 1;
      return {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: item.content.text },
        title: `Source ${sourceNum} - ${fileName} (page ${pageNum || "N/A"})`,
        context: `Full document chunk ${i + 1}/${allResults.length}, page ${pageNum || "N/A"}`,
        citations: { enabled: true },
      };
    });

    return {
      content: "",
      sources,
      documentBlocks,
    };
  } catch (error) {
    console.error("retrieve_full_document error:", error);
    return {
      content: `Failed to retrieve full document "${documentName}". The search tool encountered an error.`,
      sources: [],
      documentBlocks: [],
    };
  }
}

const getUserResponse = async (id, requestJSON) => {
  try {
    const data = requestJSON.data;    

    let userMessage = data.userMessage;
    const userId = data.user_id;
    const sessionId = data.session_id;
    const displayName = data.display_name || "";
    const agency = data.agency || "";
    const chatHistory = data.chatHistory;
    const isFirstTurn = !Array.isArray(chatHistory) || chatHistory.length === 0;
    
    const knowledgeBase = new BedrockAgentRuntimeClient({ region: 'us-east-1' });

    if (!process.env.KB_ID) {
      throw new Error("Knowledge Base ID is not found.");
    }        

    // Keep last 12 exchange pairs. Context compression kicks in as a safety net
    // if the assembled history exceeds COMPRESSION_THRESHOLD (~120K tokens).
    let claude = new ClaudeModel();
    let lastMessages = chatHistory.slice(-12);
    const promptConfig = await constructSysPrompt();
    const SYS_PROMPT = promptConfig.promptText;

    let stopLoop = false;
    let modelResponse = ''
    let connectionGone = false;
    const safeSend = async (params) => {
      if (connectionGone) return;
      try {
        await wsConnectionClient.send(new PostToConnectionCommand(params));
      } catch (err) {
        if (err.name === 'GoneException' || err.$metadata?.httpStatusCode === 410) {
          if (!connectionGone) {
            console.warn('Client disconnected (GoneException). Suppressing further send attempts.');
            connectionGone = true;
          }
          return;
        }
        throw err;
      }
    };
    let toolRoundCount = 0;
    const MAX_TOOL_ROUNDS = 20;
    let contextCompressed = false;
    let contextSummary = null;

    let history = claude.assembleHistory(lastMessages, userMessage)

    // Load existing context summary from DynamoDB if available (persisted from a prior compression)
    try {
      const sessionFetch = await lambdaClient.send(new InvokeCommand({
        FunctionName: process.env.SESSION_HANDLER,
        Payload: JSON.stringify({
          body: JSON.stringify({
            operation: "get_session",
            user_id: userId,
            session_id: sessionId,
          })
        }),
      }));
      const sessionData = JSON.parse(Buffer.from(sessionFetch.Payload).toString());
      if (sessionData.statusCode === 200) {
        const sessionBody = JSON.parse(sessionData.body);
        if (sessionBody.context_summary) {
          history = [
            { role: "user", content: [{ type: "text", text: `[CONVERSATION SUMMARY]\n${sessionBody.context_summary}` }] },
            { role: "assistant", content: [{ type: "text", text: "Understood. I have the context from our earlier conversation and will continue naturally." }] },
            ...history
          ];
          console.log("Loaded existing context summary from DynamoDB.");
        }
      }
    } catch (fetchErr) {
      console.error("Failed to fetch session for summary:", fetchErr);
    }    
    let fullDocs = {"content" : "", "sources" : []}
    let documentIndexMap = [];
    const { tools: currentTools, indexes: currentIndexes } = await getAllTools();
    
    let streamRetries = 0;
    const MAX_STREAM_RETRIES = 3;
    while (!stopLoop) {
      console.log("started new stream")
      history.forEach((historyItem) => {
        console.log(historyItem)
      })
      
      let estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);

      // Auto-compress: summarize older history when context exceeds 75% capacity
      if (estimatedTokens > COMPRESSION_THRESHOLD && !contextCompressed) {
        console.log(`Context at ~${estimatedTokens} tokens (>${COMPRESSION_THRESHOLD}). Compressing.`);
        try {
          const result = await summarizeHistory(history, id);
          if (result) {
            history = result.compressedHistory;
            contextSummary = result.summaryText;
            contextCompressed = true;
            estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
            console.log(`Compressed context to ~${estimatedTokens} tokens.`);
          }
        } catch (compressErr) {
          console.error("Context compression failed:", compressErr);
          // Fall through to existing overflow handling
        }
        estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
      }

      if (estimatedTokens > MAX_ESTIMATED_TOKENS) {
        console.error(`Context too large: ~${estimatedTokens} tokens. Aggressively trimming tool results.`);
        const AGGRESSIVE_TRIM_THRESHOLD = 5000;
        let trimmed = false;
        for (const msg of history) {
          if (!Array.isArray(msg.content)) continue;
          for (const block of msg.content) {
            if (block.type === "document" && block.source?.data && block.source.data.length > AGGRESSIVE_TRIM_THRESHOLD) {
              try {
                const parsed = JSON.parse(block.source.data);
                block.source.data = JSON.stringify({
                  total_matches: parsed.total_matches,
                  returned: 0,
                  rows: [],
                  _trimmed_by_overflow: true,
                  _note: `Results trimmed to fit context. Use count_unique, group_by, or narrower filters.`
                });
                trimmed = true;
              } catch (_) {
                block.source.data = '{"_trimmed_by_overflow":true,"rows":[],"returned":0}';
                trimmed = true;
              }
            }
          }
          estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
          if (estimatedTokens <= MAX_ESTIMATED_TOKENS) break;
        }
        estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
        if (estimatedTokens > MAX_ESTIMATED_TOKENS || !trimmed) {
          console.error(`Context still too large after trim: ~${estimatedTokens} tokens. Aborting.`);
          try {
            await safeSend({
              ConnectionId: id,
              Data: "<!ERROR!>: The conversation has accumulated too much data to process. Please start a new conversation or ask a more specific question."
            });
          } catch (sendErr) {
            console.warn("Error send failed:", sendErr);
          }
          break;
        }
        console.log(`Trimmed context to ~${estimatedTokens} tokens. Continuing.`);
      }

      let stream;
      try {
        stream = await claude.getStreamedResponse(SYS_PROMPT, history, currentTools);
      } catch (modelError) {
        console.error("Model invocation failed:", modelError);
        try {
          await safeSend({
            ConnectionId: id,
            Data: "<!ERROR!>: I'm sorry, something went wrong processing your request. Please try again or rephrase your question."
          });
        } catch (sendErr) {
          console.warn("Error send failed:", sendErr);
        }
        break;
      }
      
      try {
        let currentIterationText = "";
        let currentIterationCitations = [];
        // Map of content block index -> { id, name, inputJson } for parallel tool calls
        const pendingTools = new Map();
        
        for await (const event of stream) {
          const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
          const parsedChunk = await claude.parseChunk(chunk);
          if (!parsedChunk) continue;

          // --- Handle stop_reason ---
          if (parsedChunk.stop_reason) {
            if (parsedChunk.stop_reason === "tool_use") {
              // All tool_use blocks and their input deltas have arrived; execute them
              const toolCalls = [...pendingTools.values()];
              toolRoundCount += toolCalls.length;
              if (toolRoundCount > MAX_TOOL_ROUNDS) {
                console.error(`Exceeded MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}). Breaking out of tool loop.`);
                try {
                  await safeSend({
                    ConnectionId: id,
                    Data: "I've reached the maximum number of search iterations for this question. Here's what I found so far based on my research."
                  });
                } catch (statusErr) {
                  console.warn("Status send failed:", statusErr);
                }
                modelResponse = "I've reached the maximum number of search iterations. Please try rephrasing your question or asking something more specific.";
                stopLoop = true;
                break;
              }
              console.log(`tool round: ${toolCalls.length} parallel call(s), cumulative ${toolRoundCount}/${MAX_TOOL_ROUNDS}`);

              // Build the assistant message with text + all tool_use blocks
              const assistantContent = [];
              if (currentIterationText.length > 0) {
                assistantContent.push({ type: "text", text: currentIterationText });
              }

              let allParsed = true;
              for (const tc of toolCalls) {
                try {
                  tc.parsedInput = JSON.parse(tc.inputJson);
                } catch (parseError) {
                  console.error(`Failed to parse tool input for ${tc.name} (${tc.id}):`, tc.inputJson, parseError);
                  tc.parsedInput = null;
                  allParsed = false;
                }
                assistantContent.push({
                  type: "tool_use",
                  id: tc.id,
                  name: tc.name,
                  input: tc.parsedInput ?? {},
                });
              }
              history.push({ role: "assistant", content: assistantContent });

              if (!allParsed && toolCalls.length === 1 && toolCalls[0].parsedInput === null) {
                history.push({
                  role: "user",
                  content: [{
                    type: "tool_result",
                    tool_use_id: toolCalls[0].id,
                    content: "Error: could not process the tool input. Please respond to the user without using tools."
                  }]
                });
                pendingTools.clear();
                currentIterationText = "";
                currentIterationCitations = [];
                continue;
              }

              // Execute tools sequentially to avoid chunkIndex race on fullDocs.sources
              const toolResults = [];
              for (const tc of toolCalls) {
                const query = tc.parsedInput;
                if (query === null) {
                  toolResults.push({ toolId: tc.id, content: "Error: could not parse tool input.", documentBlocks: [] });
                  continue;
                }

                if (tc.name === "query_db") {
                  console.log("using knowledge bases!");
                  const statusQuery = truncate(query.query);
                  try {
                    await safeSend({
                      ConnectionId: id, Data: statusQuery
                        ? `!<|STATUS|>!Searching documents for "${statusQuery}"...`
                        : "!<|STATUS|>!Searching documents..."
                    });
                  } catch (statusErr) {
                    console.warn("Status send failed:", statusErr);
                  }
                  const docResult = await retrieveKBDocs(query.query, knowledgeBase, process.env.KB_ID, fullDocs.sources.length);
                  fullDocs.sources = fullDocs.sources.concat(docResult.sources);
                  for (const src of docResult.sources) {
                    documentIndexMap.push(src);
                  }
                  const text = docResult.documentBlocks.length > 0
                    ? `Retrieved ${docResult.documentBlocks.length} relevant documents. Analyze the attached documents to answer the user's question.`
                    : docResult.content;
                  console.log("correctly used tool: query_db");
                  toolResults.push({ toolId: tc.id, content: text, documentBlocks: docResult.documentBlocks });

                } else if (tc.name === "retrieve_full_document") {
                  console.log(`retrieving full document: ${query.document_name}`);
                  const docNameDisplay = truncate(query.document_name);
                  try {
                    await safeSend({
                      ConnectionId: id, Data: `!<|STATUS|>!Retrieving full document "${docNameDisplay}"...`
                    });
                  } catch (statusErr) {
                    console.warn("Status send failed:", statusErr);
                  }
                  const fullDocResult = await retrieveFullDocument(
                    query.document_name, knowledgeBase, process.env.KB_ID,
                    query.query_context || null, fullDocs.sources.length
                  );
                  fullDocs.sources = fullDocs.sources.concat(fullDocResult.sources);
                  for (const src of fullDocResult.sources) {
                    documentIndexMap.push(src);
                  }
                  const text = fullDocResult.documentBlocks.length > 0
                    ? `Retrieved complete document "${query.document_name}" (${fullDocResult.documentBlocks.length} chunks). Analyze the attached document blocks — they contain the full document in page order.`
                    : fullDocResult.content;
                  console.log("correctly used tool: retrieve_full_document");
                  toolResults.push({ toolId: tc.id, content: text, documentBlocks: fullDocResult.documentBlocks });

                } else if (tc.name === "fetch_metadata") {
                  console.log("fetching metadata!");
                  try {
                    await safeSend({
                      ConnectionId: id, Data: "!<|STATUS|>!Fetching contract metadata..."
                    });
                  } catch (statusErr) {
                    console.warn("Status send failed:", statusErr);
                  }
                  const metadata = await fetchMetadata();
                  console.log("correctly used tool: fetch_metadata");
                  toolResults.push({ toolId: tc.id, content: metadata ? JSON.stringify(metadata) : "No metadata available.", documentBlocks: [] });

                } else if (tc.name === "query_excel_index") {
                  const indexName = query.index_name;
                  const idxMeta = currentIndexes.find(i => i.index_name === indexName);
                  const displayName = idxMeta?.display_name || indexName;
                  const searchTerm = truncate(query.free_text);
                  console.log(`querying excel index: ${indexName}`);
                  let statusMsg;
                  if (searchTerm) {
                    statusMsg = `Searching ${displayName} for "${searchTerm}"...`;
                  } else if (query.filters && Object.keys(query.filters).length > 0) {
                    statusMsg = `Searching ${displayName} with filters...`;
                  } else {
                    statusMsg = `Searching ${displayName}...`;
                  }
                  try {
                    await safeSend({ ConnectionId: id, Data: `!<|STATUS|>!${statusMsg}` });
                  } catch (statusErr) {
                    console.warn("Status send failed:", statusErr);
                  }
                  let toolResultContent = await invokeIndexQuery({
                    action: "query",
                    index_name: indexName,
                    free_text: query.free_text || null,
                    filters: query.filters || null,
                    date_before: query.date_before || null,
                    date_after: query.date_after || null,
                    columns: Array.isArray(query.columns) ? query.columns : null,
                    count_only: query.count_only === true,
                    count_unique: query.count_unique || null,
                    group_by: query.group_by || null,
                    group_by_value_max: query.group_by_value_max || null,
                    distinct_values: query.distinct_values || null,
                    min_value: query.min_value || null,
                    max_value: query.max_value || null,
                    sort_by: query.sort_by || null,
                    sort_order: query.sort_order || "asc",
                    limit: typeof query.limit === "number" ? query.limit : 100,
                    offset: typeof query.offset === "number" ? query.offset : 0,
                  });

                  toolResultContent = await enrichExcelIndexResult(query, indexName, toolResultContent, idxMeta);
                  toolResultContent = capToolResultSize(toolResultContent);

                  const excelSourceIndex = fullDocs.sources.length + 1;
                  let excelExcerpt = "";
                  try {
                    const resultData = JSON.parse(toolResultContent);
                    excelExcerpt = `${resultData.total_matches || 0} rows matched`;
                    if (query.free_text) excelExcerpt += ` for "${query.free_text}"`;
                    if (query.filters && Object.keys(query.filters).length > 0) {
                      excelExcerpt += ` with filters: ${Object.entries(query.filters).map(([k,v]) => `${k}="${v}"`).join(", ")}`;
                    }
                  } catch (_) {
                    excelExcerpt = "Excel index query results";
                  }
                  const excelSource = {
                    chunkIndex: excelSourceIndex,
                    title: displayName,
                    uri: null,
                    excerpt: excelExcerpt,
                    score: null,
                    page: null,
                    s3Key: null,
                    sourceType: "excelIndex"
                  };
                  fullDocs.sources.push(excelSource);
                  documentIndexMap.push(excelSource);
                  const excelDocBlock = {
                    type: "document",
                    source: { type: "text", media_type: "text/plain", data: String(toolResultContent) },
                    title: `Source ${excelSourceIndex} - ${displayName} (Excel Data)`,
                    context: excelExcerpt,
                    citations: { enabled: true }
                  };
                  console.log("correctly used tool: query_excel_index");
                  toolResults.push({ toolId: tc.id, content: `Excel query results from ${displayName}. Analyze the attached document.`, documentBlocks: [excelDocBlock] });

                } else {
                  console.warn("Unknown tool:", tc.name);
                  toolResults.push({ toolId: tc.id, content: "Unknown tool requested.", documentBlocks: [] });
                }
              }

              // Build the single user message with all tool_result blocks
              // Per Anthropic API: tool_result blocks must come FIRST, then document blocks
              const userContent = [];
              const allDocBlocks = [];
              for (const result of toolResults) {
                userContent.push({
                  type: "tool_result",
                  tool_use_id: result.toolId,
                  content: result.content,
                });
                if (result.documentBlocks && result.documentBlocks.length > 0) {
                  allDocBlocks.push(...result.documentBlocks);
                }
              }
              userContent.push(...allDocBlocks);
              history.push({ role: "user", content: userContent });

              try {
                await safeSend({ ConnectionId: id, Data: "!<|STATUS|>!Reading through the results..." });
              } catch (statusErr) {
                console.warn("Status send failed:", statusErr);
              }

              pendingTools.clear();
              currentIterationText = "";
              currentIterationCitations = [];

            } else {
              // Non-tool stop (end_turn, max_tokens, etc.)
              if (currentIterationText.length > 0) {
                if (currentIterationCitations.length > 0) {
                  currentIterationText = insertCitationMarkers(
                    currentIterationText, currentIterationCitations,
                    documentIndexMap, fullDocs.sources
                  );
                } else if (fullDocs.sources.length > 0) {
                  currentIterationText = validateSelfManagedCitations(
                    currentIterationText, fullDocs.sources
                  );
                }
                try {
                  await safeSend({ ConnectionId: id, Data: currentIterationText });
                } catch (err) {
                  console.error("Error flushing final answer:", err);
                }
              }
              modelResponse = currentIterationText;
              stopLoop = true;
              break;
            }
            continue;
          }

          // --- Handle content_block_start for tool_use ---
          if (parsedChunk.type === "tool_use") {
            pendingTools.set(parsedChunk.index, {
              id: parsedChunk.id,
              name: parsedChunk.name,
              inputJson: "",
            });
            continue;
          }

          // --- Handle streaming deltas ---
          if (parsedChunk.kind === "tool_input" && parsedChunk.json != null) {
            const entry = pendingTools.get(parsedChunk.index);
            if (entry) {
              entry.inputJson += parsedChunk.json;
            }
          } else if (parsedChunk.kind === "text") {
            currentIterationText += parsedChunk.text;
          } else if (parsedChunk.kind === "citation") {
            currentIterationCitations.push({
              textOffset: currentIterationText.length,
              citation: parsedChunk.citation,
            });
          }
        }
        
      } catch (error) {
        console.error("Stream processing error:", error);
        streamRetries++;
        if (streamRetries >= MAX_STREAM_RETRIES) {
          try {
            await safeSend({
              ConnectionId: id,
              Data: "<!ERROR!>: I'm sorry, something went wrong processing your request. Please try again or rephrase your question."
            });
          } catch (sendErr) {
            console.warn("Error send failed:", sendErr);
          }
          stopLoop = true;
        } else {
          console.log(`Stream retry ${streamRetries}/${MAX_STREAM_RETRIES}`);
        }
      }
  
    }

    let command;
    const messageId = randomUUID();
    const turnIndex = Array.isArray(chatHistory) ? chatHistory.length + 1 : 1;
    try {
      await writeResponseTrace({
        messageId,
        sessionId,
        turnIndex,
        userPrompt: userMessage,
        finalAnswer: modelResponse,
        sources: fullDocs.sources,
        promptVersionId: promptConfig.promptVersionId,
        promptTemplateHash: promptConfig.promptTemplateHash,
        modelId: claude.modelId,
        guardrailId: process.env.GUARDRAIL_ID || "",
      });
    } catch (traceError) {
      console.error("Failed to persist response trace:", traceError);
    }
    const responseMetadata = JSON.stringify({
      Sources: fullDocs.sources,
      Trace: {
        messageId,
        sessionId,
        promptVersionId: promptConfig.promptVersionId,
        promptTemplateHash: promptConfig.promptTemplateHash,
        turnIndex,
      },
    });
    // send end of stream message
    try {
      await safeSend({ ConnectionId: id, Data: "!<|EOF_STREAM|>!" });
      await safeSend({ ConnectionId: id, Data: responseMetadata });
    } catch (e) {
      console.error("Error sending EOF_STREAM and sources:", e);
    }

    // Async FAQ classification (fire-and-forget)
    if (process.env.FAQ_CLASSIFIER_FUNCTION) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: process.env.FAQ_CLASSIFIER_FUNCTION,
          InvocationType: 'Event',
          Payload: JSON.stringify({
            userMessage,
            userId,
            sessionId,
            displayName,
            agency,
            timestamp: new Date().toISOString(),
          }),
        }));
      } catch (classifyErr) {
        console.error("FAQ classification fire-and-forget failed:", classifyErr);
      }
    }

    let title = "";
    const finalResponse = modelResponse || "I'm sorry, I was unable to generate a response. Please try again.";
    let newChatEntry = { "user": userMessage, "chatbot": finalResponse, "metadata": responseMetadata };
    if (isFirstTurn) {
      try {
        let titleModel = new ClaudeModel(process.env.FAST_MODEL_ID);
        title = await titleModel.getResponse(
          "Generate a short title (3-8 words) summarizing the USER's question topic. Rules: output ONLY the title, no quotes, no explanation, no apologies. Focus on what the user is asking about, not the assistant's response. Examples: 'HVAC Trade Vendor Contracts', 'W.B. Mason Contract Lookup', 'Laptop Procurement Process'.",
          [],
          `User: ${userMessage}`,
          { maxTokens: 15 }
        );
        title = title.replaceAll(`"`, '').trim();
        if (title.length > 80) {
          title = userMessage.substring(0, 75).trim();
        }
      } catch (titleError) {
        console.error("Title generation failed:", titleError);
        title = userMessage.substring(0, 50);
      }
    }

    const sessionSaveRequest = {
      body: JSON.stringify({
        "operation": "append_chat_entry",
        "user_id": userId,
        "session_id": sessionId,
        "new_chat_entry": newChatEntry,
        "title": title
      })
    }

    const lambdaSaveCommand = new InvokeCommand({
      FunctionName: process.env.SESSION_HANDLER,
      Payload: JSON.stringify(sessionSaveRequest),
    });

    const saveResponse = await lambdaClient.send(lambdaSaveCommand);
    if (saveResponse.Payload) {
      try {
        const parsedSave = JSON.parse(Buffer.from(saveResponse.Payload).toString());
        if (parsedSave.statusCode && parsedSave.statusCode >= 400) {
          console.error("Session save failed:", parsedSave.body);
        }
      } catch (saveParseError) {
        console.error("Failed to parse session save response:", saveParseError);
      }
    }

    // Persist context summary to DynamoDB so it survives page reloads
    if (contextSummary) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: process.env.SESSION_HANDLER,
          Payload: JSON.stringify({
            body: JSON.stringify({
              operation: "update_context_summary",
              user_id: userId,
              session_id: sessionId,
              context_summary: contextSummary,
            })
          }),
        }));
        console.log("Context summary persisted to DynamoDB.");
      } catch (sumErr) {
        console.error("Failed to save context summary:", sumErr);
      }
    }

    if (!connectionGone) {
      try {
        await wsConnectionClient.send(new DeleteConnectionCommand({ ConnectionId: id }));
      } catch (disconnectErr) {
        console.warn("Connection cleanup failed:", disconnectErr);
      }
    }

  } catch (error) {
    console.error("Error:", error);
    try {
      const errorTraceId = randomUUID();
      await writeResponseTrace({
        messageId: errorTraceId,
        sessionId: requestJSON?.data?.session_id || "unknown",
        turnIndex: 0,
        userPrompt: requestJSON?.data?.userMessage || "",
        finalAnswer: "",
        sources: [],
        promptVersionId: "error",
        promptTemplateHash: "",
        modelId: "",
        guardrailId: "",
      });
    } catch (traceErr) {
      console.error("Failed to write error trace:", traceErr);
    }
    try {
      await wsConnectionClient.send(new PostToConnectionCommand({
        ConnectionId: id,
        Data: "<!ERROR!>: I'm sorry, something went wrong. Please try again or rephrase your question."
      }));
    } catch (sendErr) {
      console.warn("Final error send failed:", sendErr);
    }
  }
}

export const handler = async (event) => {
  if (event.requestContext) {    
    const connectionId = event.requestContext.connectionId;
    const routeKey = event.requestContext.routeKey;
    let body = {};
    try {
      if (event.body) {
        body = JSON.parse(event.body);
      }
    } catch (err) {
      console.error("Failed to parse JSON:", err)
    }
    console.log(routeKey);

    switch (routeKey) {
      case '$connect':
        console.log('CONNECT')
        return { statusCode: 200 };
      case '$disconnect':
        console.log('DISCONNECT')
        return { statusCode: 200 };
      case '$default':
        console.log('DEFAULT')
        return { 'action': 'Default Response Triggered' }
      case "getChatbotResponse":
        console.log('GET CHATBOT RESPONSE')
        await getUserResponse(connectionId, body)
        return { statusCode: 200 };      
      default:
        return {
          statusCode: 404,  // 'Not Found' status code
          body: JSON.stringify({
            error: "The requested route is not recognized."
          })
        };
    }
  }
  return {
    statusCode: 200,
  };
};
