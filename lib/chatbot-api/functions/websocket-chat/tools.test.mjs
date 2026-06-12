import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLambdaSend = vi.hoisted(() => vi.fn());

// tools.mjs imports these AWS packages which are not installed at the root
// (they're Lambda-only, bundled by CDK esbuild). Stub them so the module loads.
vi.mock("@aws-sdk/client-dynamodb", () => ({
  // vitest 4 requires constructor mocks to be `function`/`class` (not arrows)
  // since these are instantiated with `new` in tools.mjs.
  DynamoDBClient: vi.fn(function () { return { send: vi.fn() }; }),
  QueryCommand:   vi.fn(function (i) { return i; }),
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient:  vi.fn(function () { return { send: mockLambdaSend }; }),
  InvokeCommand: vi.fn(function (i) { return i; }),
}));
vi.mock("./prompt.mjs",          () => ({ PROMPT: "test prompt" }));
vi.mock("./prompt-registry.mjs", () => ({ loadRenderedPrompt: vi.fn() }));

import {
  truncate,
  capToolResultSize,
  pickEntityIdColumn,
  pickDateColumnFromQuery,
  buildExcelIndexTool,
  excelQueryNeedsEntitySummaryEnrichment,
  enrichExcelIndexResult,
  fetchMetadata,
  STATIC_TOOLS,
} from "./tools.mjs";

// ---------------------------------------------------------------------------
// STATIC_TOOLS — query_db schema
// ---------------------------------------------------------------------------

describe("STATIC_TOOLS query_db schema", () => {
  const queryDb = STATIC_TOOLS.find(t => t.name === "query_db");

  it("declares an optional within_document string property", () => {
    expect(queryDb.input_schema.properties.within_document).toBeDefined();
    expect(queryDb.input_schema.properties.within_document.type).toBe("string");
  });

  it("keeps query as the only required property", () => {
    expect(queryDb.input_schema.required).toEqual(["query"]);
  });
});

// ---------------------------------------------------------------------------
// STATIC_TOOLS — fetch_metadata schema
// ---------------------------------------------------------------------------

describe("STATIC_TOOLS fetch_metadata schema", () => {
  const fetchMeta = STATIC_TOOLS.find(t => t.name === "fetch_metadata");

  it("declares an optional filename_contains string property", () => {
    expect(fetchMeta.input_schema.properties.filename_contains).toBeDefined();
    expect(fetchMeta.input_schema.properties.filename_contains.type).toBe("string");
  });

  it("keeps all properties optional", () => {
    expect(fetchMeta.input_schema.required).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("returns string unchanged when under max", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates with ellipsis when over max", () => {
    const result = truncate("hello world", 5);
    expect(result).toBe("hello\u2026");
  });

  it("does not truncate string at exactly max length", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  it("returns empty string for null", () => {
    expect(truncate(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(truncate(undefined)).toBe("");
  });

  it("uses default max of 60", () => {
    const str = "a".repeat(61);
    const result = truncate(str);
    expect(result.endsWith("\u2026")).toBe(true);
    expect(result.length).toBe(61); // 60 chars + ellipsis char
  });
});

// ---------------------------------------------------------------------------
// capToolResultSize
// ---------------------------------------------------------------------------

describe("capToolResultSize", () => {
  const MAX = 60_000;

  it("returns string unchanged when under limit", () => {
    const str = JSON.stringify({ rows: [{ a: 1 }], total_matches: 1 });
    expect(capToolResultSize(str)).toBe(str);
  });

  it("returns non-string input unchanged", () => {
    expect(capToolResultSize(null)).toBeNull();
    expect(capToolResultSize(42)).toBe(42);
  });

  it("truncates rows array when over limit and adds truncation metadata", () => {
    const bigRow = { data: "x".repeat(1000) };
    const rows = Array.from({ length: 200 }, (_, i) => ({ ...bigRow, id: i }));
    const input = JSON.stringify({ rows, total_matches: 200 });
    expect(input.length).toBeGreaterThan(MAX);

    const result = capToolResultSize(input);
    const parsed = JSON.parse(result);

    expect(parsed._truncated).toBe(true);
    expect(parsed.rows.length).toBeLessThan(200);
    expect(parsed._note).toContain("rows shown");
    expect(parsed._note).toContain("offset=");
  });

  it("truncated result fits within MAX_TOOL_RESULT_CHARS", () => {
    const bigRow = { data: "x".repeat(1000) };
    const rows = Array.from({ length: 200 }, (_, i) => ({ ...bigRow, id: i }));
    const input = JSON.stringify({ rows, total_matches: 200 });
    const result = capToolResultSize(input);
    expect(result.length).toBeLessThanOrEqual(MAX);
  });

  it("falls back to a hard cut with a truncation note when input is not JSON", () => {
    const str = "x".repeat(MAX + 100);
    const result = capToolResultSize(str);
    expect(result.length).toBeLessThanOrEqual(MAX);
    expect(result).toContain("[TRUNCATED:");
  });

  it("hard-cuts oversized non-row-shaped JSON objects with a truncation note", () => {
    // A fetch_metadata full inventory is a plain {filename: {...}} object with
    // no rows array — it must still be capped, not enter history uncapped.
    const inventory = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`doc${i}.pdf`, { summary: "y".repeat(1000) }])
    );
    const input = JSON.stringify(inventory);
    expect(input.length).toBeGreaterThan(MAX);

    const result = capToolResultSize(input);
    expect(result.length).toBeLessThanOrEqual(MAX);
    expect(result).toContain("[TRUNCATED:");
    expect(result).toContain("filename_contains");
  });

  it("hard-cuts oversized JSON with an empty rows array (nothing to trim row-wise)", () => {
    const data = JSON.stringify({ rows: [], total_matches: 0, padding: "x".repeat(MAX + 100) });
    expect(data.length).toBeGreaterThan(MAX);
    const result = capToolResultSize(data);
    expect(result.length).toBeLessThanOrEqual(MAX);
    expect(result).toContain("[TRUNCATED:");
  });
});

// ---------------------------------------------------------------------------
// pickEntityIdColumn
// ---------------------------------------------------------------------------

describe("pickEntityIdColumn", () => {
  it("returns 'Contract_ID' (preferred exact match)", () => {
    expect(pickEntityIdColumn(["Vendor", "Contract_ID", "Amount"])).toBe("Contract_ID");
  });

  it("returns 'contract_id' (lowercase preferred variant)", () => {
    expect(pickEntityIdColumn(["Vendor", "contract_id", "Amount"])).toBe("contract_id");
  });

  it("returns 'ContractId' (camelCase preferred variant)", () => {
    expect(pickEntityIdColumn(["ContractId", "Amount"])).toBe("ContractId");
  });

  it("falls back to regex match for 'contract id' (space-separated)", () => {
    expect(pickEntityIdColumn(["Vendor", "contract id", "Amount"])).toBe("contract id");
  });

  it("returns null when no contract ID column found", () => {
    expect(pickEntityIdColumn(["Vendor", "Amount", "Date"])).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(pickEntityIdColumn([])).toBeNull();
  });

  it("returns null for null", () => {
    expect(pickEntityIdColumn(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(pickEntityIdColumn(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pickDateColumnFromQuery
// ---------------------------------------------------------------------------

describe("pickDateColumnFromQuery", () => {
  it("returns column name from date_before", () => {
    const q = { date_before: { Master_Blanket_Contract_EndDate: "2026-01-01" } };
    expect(pickDateColumnFromQuery(q)).toBe("Master_Blanket_Contract_EndDate");
  });

  it("returns column name from date_after", () => {
    const q = { date_after: { Contract_StartDate: "2025-01-01" } };
    expect(pickDateColumnFromQuery(q)).toBe("Contract_StartDate");
  });

  it("prefers date_before over date_after when both present", () => {
    const q = {
      date_before: { EndDate: "2026-01-01" },
      date_after:  { StartDate: "2025-01-01" },
    };
    expect(pickDateColumnFromQuery(q)).toBe("EndDate");
  });

  it("returns null when neither date_before nor date_after is set", () => {
    expect(pickDateColumnFromQuery({ filters: { col: "val" } })).toBeNull();
  });

  it("returns null when date_before is a string (not an object)", () => {
    expect(pickDateColumnFromQuery({ date_before: "2026-01-01" })).toBeNull();
  });

  it("returns null when date_before is an array", () => {
    expect(pickDateColumnFromQuery({ date_before: ["EndDate"] })).toBeNull();
  });

  it("returns null for empty query", () => {
    expect(pickDateColumnFromQuery({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildExcelIndexTool
// ---------------------------------------------------------------------------

describe("buildExcelIndexTool", () => {
  const INDEXES = [
    {
      index_name: "STATEWIDE_CONTRACTS",
      display_name: "Statewide Contracts",
      description: "All statewide procurement contracts",
      columns: ["Contract_ID", "Vendor", "Amount"],
      row_count: 500,
    },
    {
      index_name: "IT_HARDWARE",
      display_name: "IT Hardware Catalog",
      description: "",
      columns: ["Contract_ID", "Item", "Price"],
      row_count: 200,
    },
  ];

  it("returns null for empty indexes array", () => {
    expect(buildExcelIndexTool([])).toBeNull();
  });

  it("tool name is 'query_excel_index'", () => {
    expect(buildExcelIndexTool(INDEXES).name).toBe("query_excel_index");
  });

  it("enum includes all index names", () => {
    const { input_schema } = buildExcelIndexTool(INDEXES);
    const enumValues = input_schema.properties.index_name.enum;
    expect(enumValues).toContain("STATEWIDE_CONTRACTS");
    expect(enumValues).toContain("IT_HARDWARE");
  });

  it("description includes index names and descriptions", () => {
    const tool = buildExcelIndexTool(INDEXES);
    expect(tool.description).toContain("STATEWIDE_CONTRACTS");
    expect(tool.description).toContain("All statewide procurement contracts");
  });

  it("requires index_name", () => {
    const { input_schema } = buildExcelIndexTool(INDEXES);
    expect(input_schema.required).toContain("index_name");
  });

  it("works with a single index", () => {
    const tool = buildExcelIndexTool([INDEXES[0]]);
    expect(tool).not.toBeNull();
    expect(tool.input_schema.properties.index_name.enum).toEqual(["STATEWIDE_CONTRACTS"]);
  });

  it("lists date columns when date_columns is a non-empty array", () => {
    const tool = buildExcelIndexTool([{ ...INDEXES[0], date_columns: ["EndDate"] }]);
    expect(tool.description).toContain(
      "Date columns (usable with date_before/date_after/sort_by): EndDate"
    );
  });

  it("states date filtering is unavailable when date_columns is an empty array", () => {
    const tool = buildExcelIndexTool([{ ...INDEXES[0], date_columns: [] }]);
    expect(tool.description).toContain(
      "No date columns — date filtering is not available for this index."
    );
  });

  it("omits date-column lines for legacy items without date_columns", () => {
    const fromAbsent = buildExcelIndexTool([INDEXES[0]]);
    const fromNull   = buildExcelIndexTool([{ ...INDEXES[0], date_columns: null }]);
    for (const tool of [fromAbsent, fromNull]) {
      expect(tool.description).not.toContain("Date columns (usable with");
      expect(tool.description).not.toContain("No date columns");
    }
  });

  it("description has no hardcoded column-name examples", () => {
    const tool = buildExcelIndexTool(INDEXES);
    expect(tool.description).not.toContain("Master_Blanket_Contract_EndDate");
  });
});

// ---------------------------------------------------------------------------
// excelQueryNeedsEntitySummaryEnrichment
// ---------------------------------------------------------------------------

describe("excelQueryNeedsEntitySummaryEnrichment", () => {
  it("returns false for empty query", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({})).toBe(false);
  });

  it("returns false for a bare query with no filters, free_text, or dates", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({ limit: 50, offset: 0 })).toBe(false);
  });

  it("returns true when only date_before is set", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({
      date_before: { EndDate: "2026-01-01" },
    })).toBe(true);
  });

  it("returns true when only date_after is set", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({
      date_after: { StartDate: "2025-01-01" },
    })).toBe(true);
  });

  it("returns true for a free_text-only query", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({ free_text: "office supplies" })).toBe(true);
  });

  it("returns true for a filters-only query", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({ filters: { col: "val" } })).toBe(true);
  });

  it("returns false for whitespace-only free_text", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({ free_text: "   " })).toBe(false);
  });

  it("returns false for an empty filters object", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({ filters: {} })).toBe(false);
  });

  it("returns false when free_text + group_by (suppression preserved)", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({
      free_text: "office supplies",
      group_by: "Vendor",
    })).toBe(false);
  });

  it("returns false when date filter + count_unique (suppressed)", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({
      date_before: { EndDate: "2026-01-01" },
      count_unique: "Contract_ID",
    })).toBe(false);
  });

  it("returns false when date filter + group_by (suppressed)", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({
      date_after: { StartDate: "2025-01-01" },
      group_by: "Vendor",
    })).toBe(false);
  });

  it("returns false when date filter + distinct_values (suppressed)", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({
      date_before: { EndDate: "2026-01-01" },
      distinct_values: "Vendor",
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enrichExcelIndexResult
// ---------------------------------------------------------------------------

describe("enrichExcelIndexResult", () => {
  const IDX_META = { columns: ["Contract_ID", "Vendor", "EndDate"] };

  // Shape of the Lambda invoke response that invokeIndexQuery unwraps.
  const lambdaResponse = (body) => ({
    Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify(body) })),
  });

  beforeEach(() => {
    mockLambdaSend.mockReset();
    process.env.EXCEL_INDEX_QUERY_FUNCTION = "test-excel-query-fn";
  });

  it("injects _entity_summary for a free_text query", async () => {
    mockLambdaSend.mockResolvedValue(lambdaResponse({
      unique_count: 3,
      groups: { C1: 5, C2: 3, C3: 2 },
    }));
    const result = await enrichExcelIndexResult(
      { free_text: "facilities" },
      "statewide",
      JSON.stringify({ total_matches: 10, rows: [] }),
      IDX_META,
    );
    const parsed = JSON.parse(result);
    expect(parsed._entity_summary.entity_id_column).toBe("Contract_ID");
    expect(parsed._entity_summary.distinct_entity_count).toBe(3);
    expect(parsed._entity_summary.row_total_matches).toBe(10);
    expect(parsed._entity_summary.rows_per_entity).toEqual({ C1: 5, C2: 3, C3: 2 });
  });

  it("omits group_by_value_max from the enrichment query when no date column is in play", async () => {
    mockLambdaSend.mockResolvedValue(lambdaResponse({ unique_count: 2, groups: { A: 1, B: 1 } }));
    await enrichExcelIndexResult(
      { filters: { Vendor: "Acme" } },
      "statewide",
      JSON.stringify({ total_matches: 2, rows: [] }),
      IDX_META,
    );
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(Buffer.from(mockLambdaSend.mock.calls[0][0].Payload).toString());
    expect(sent.count_unique).toBe("Contract_ID");
    expect(sent.group_by).toBe("Contract_ID");
    expect("group_by_value_max" in sent).toBe(false);
  });

  it("skips the second query when total_matches is 1", async () => {
    const original = JSON.stringify({ total_matches: 1, rows: [{ Contract_ID: "C1" }] });
    const result = await enrichExcelIndexResult(
      { free_text: "acme" }, "statewide", original, IDX_META,
    );
    expect(result).toBe(original);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it("skips the second query when total_matches is 0", async () => {
    const original = JSON.stringify({ total_matches: 0, rows: [] });
    const result = await enrichExcelIndexResult(
      { free_text: "acme" }, "statewide", original, IDX_META,
    );
    expect(result).toBe(original);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it("omits per-entity maps and adds a note when more than 50 entity groups return", async () => {
    const groups = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`C${i}`, 2]));
    const maxVals = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`C${i}`, "2026-01-01"]));
    mockLambdaSend.mockResolvedValue(lambdaResponse({
      unique_count: 51,
      groups,
      group_max_values: maxVals,
      group_by_value_max_column: "EndDate",
    }));
    const result = await enrichExcelIndexResult(
      { date_before: { EndDate: "2026-12-31" } },
      "statewide",
      JSON.stringify({ total_matches: 102, rows: [] }),
      IDX_META,
    );
    const parsed = JSON.parse(result);
    expect(parsed._entity_summary.distinct_entity_count).toBe(51);
    expect(parsed._entity_summary.rows_per_entity).toBeUndefined();
    expect(parsed._entity_summary.max_value_per_entity).toBeUndefined();
    expect(parsed._entity_summary.breakdown_note).toContain("51 entities");
    expect(parsed._entity_summary.breakdown_note).toContain("group_by");
  });

  it("keeps per-entity maps at 50 or fewer entity groups", async () => {
    const groups = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`C${i}`, 2]));
    const maxVals = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`C${i}`, "2026-01-01"]));
    mockLambdaSend.mockResolvedValue(lambdaResponse({
      unique_count: 50,
      groups,
      group_max_values: maxVals,
      group_by_value_max_column: "EndDate",
    }));
    const result = await enrichExcelIndexResult(
      { date_before: { EndDate: "2026-12-31" } },
      "statewide",
      JSON.stringify({ total_matches: 100, rows: [] }),
      IDX_META,
    );
    const parsed = JSON.parse(result);
    expect(parsed._entity_summary.rows_per_entity).toEqual(groups);
    expect(parsed._entity_summary.max_value_per_entity).toEqual(maxVals);
    expect(parsed._entity_summary.value_column).toBe("EndDate");
    expect(parsed._entity_summary.breakdown_note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchMetadata
// ---------------------------------------------------------------------------

describe("fetchMetadata", () => {
  // Shape of the Lambda invoke response that fetchMetadata unwraps.
  const lambdaResponse = (metadata) => ({
    Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ metadata }) })),
  });

  beforeEach(() => {
    mockLambdaSend.mockReset();
    process.env.METADATA_RETRIEVAL_FUNCTION = "test-metadata-fn";
  });

  it("forwards filename_contains in the invoke payload", async () => {
    mockLambdaSend.mockResolvedValue(lambdaResponse({ "FAC115 CUG.pdf": "user guide" }));
    const result = await fetchMetadata({ full: true, filenameContains: "FAC115" });
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(Buffer.from(mockLambdaSend.mock.calls[0][0].Payload).toString());
    expect(sent.full).toBe(true);
    expect(sent.filename_contains).toBe("FAC115");
    expect(result).toEqual({ "FAC115 CUG.pdf": "user guide" });
  });

  it("omits filename_contains from the payload when not provided (backward compatible)", async () => {
    mockLambdaSend.mockResolvedValue(lambdaResponse({ "doc1.pdf": "memos" }));
    await fetchMetadata();
    const sent = JSON.parse(Buffer.from(mockLambdaSend.mock.calls[0][0].Payload).toString());
    expect(sent.full).toBe(false);
    expect("filename_contains" in sent).toBe(false);
  });

  it("returns null when the invoke fails", async () => {
    mockLambdaSend.mockRejectedValue(new Error("boom"));
    const result = await fetchMetadata({ filenameContains: "FAC115" });
    expect(result).toBeNull();
  });
});
