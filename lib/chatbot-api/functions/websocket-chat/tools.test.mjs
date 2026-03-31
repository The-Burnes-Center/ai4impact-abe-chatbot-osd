import { describe, it, expect, vi } from "vitest";

// tools.mjs imports these AWS packages which are not installed at the root
// (they're Lambda-only, bundled by CDK esbuild). Stub them so the module loads.
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(() => ({ send: vi.fn() })),
  QueryCommand:   vi.fn(i => i),
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient:  vi.fn(() => ({ send: vi.fn() })),
  InvokeCommand: vi.fn(i => i),
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
} from "./tools.mjs";

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

  it("falls back to raw slice when JSON has no rows array", () => {
    const str = "x".repeat(MAX + 100);
    const result = capToolResultSize(str);
    expect(result.length).toBeLessThanOrEqual(MAX);
  });

  it("returns original string when rows array is empty (early-return, no slicing)", () => {
    // Valid JSON over the limit with empty rows — the function hits the early-return branch
    // "if (!Array.isArray(data.rows) || data.rows.length === 0) return resultStr"
    const data = JSON.stringify({ rows: [], total_matches: 0, padding: "x".repeat(MAX + 100) });
    expect(data.length).toBeGreaterThan(MAX);
    expect(capToolResultSize(data)).toBe(data);
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
});

// ---------------------------------------------------------------------------
// excelQueryNeedsEntitySummaryEnrichment
// ---------------------------------------------------------------------------

describe("excelQueryNeedsEntitySummaryEnrichment", () => {
  it("returns false when no date filters present", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({ filters: { col: "val" } })).toBe(false);
  });

  it("returns false for empty query", () => {
    expect(excelQueryNeedsEntitySummaryEnrichment({})).toBe(false);
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
