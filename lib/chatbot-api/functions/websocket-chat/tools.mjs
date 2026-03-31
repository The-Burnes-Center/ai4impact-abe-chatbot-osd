import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { PROMPT } from './prompt.mjs';
import { loadRenderedPrompt } from './prompt-registry.mjs';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const lambdaClient = new LambdaClient({});

// Static tools that don't depend on Excel schemas
export const STATIC_TOOLS = [
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

export function truncate(str, max = 60) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "\u2026" : str;
}

const MAX_TOOL_RESULT_CHARS = 60000;

/**
 * Cap a serialized tool-result string so it doesn't blow the context window.
 * If the JSON is over budget, truncate the `rows` array to fit and append a
 * note so the model knows the data is partial.
 */
export function capToolResultSize(resultStr) {
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

/**
 * Load index metadata from the Index Registry DynamoDB table.
 * Called once at cold-start; cached for the Lambda instance lifetime.
 */
export async function loadIndexMetadata() {
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
export function buildExcelIndexTool(indexes) {
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

/** Build the full tools array fresh from registry (called per-request). */
export async function getAllTools() {
  const indexes = await loadIndexMetadata();
  const excelTool = buildExcelIndexTool(indexes);
  const tools = [...STATIC_TOOLS, ...(excelTool ? [excelTool] : [])];
  console.log(`Tools for request: ${tools.length} (${STATIC_TOOLS.length} static + ${excelTool ? 1 : 0} dynamic)`);
  return { tools, indexes };
}

export const fetchMetadata = async () => {
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

export function pickEntityIdColumn(columns) {
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

export function pickDateColumnFromQuery(query) {
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

export function excelQueryNeedsEntitySummaryEnrichment(query) {
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
export async function enrichExcelIndexResult(query, indexName, toolResultStr, idxMeta) {
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
export async function invokeIndexQuery(payload) {
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

export async function constructSysPrompt() {
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
