import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoist the mock function so vi.mock() factory can reference it
const mockS3Send = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn(input => input),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(() => Promise.resolve("https://signed.url/test")),
}));

// kb.mjs imports this for retrieveKBDocs/retrieveFullDocument but not for the
// functions under test; mock it so the module can be loaded in the test runner.
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  RetrieveCommand: vi.fn(i => i),
}));

import { getMetadataKeys, resolveDocumentName, METADATA_KEYS_TTL } from "./kb.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake S3 GetObject response whose body is a metadata.txt JSON object. */
function s3BodyFor(keys) {
  const obj = Object.fromEntries(keys.map(k => [k, { tags: [], summary: "" }]));
  return { Body: { transformToString: () => Promise.resolve(JSON.stringify(obj)) } };
}

/**
 * Advance the module-level cache epoch by 2× TTL before each test so that
 * any cache populated by a previous test is guaranteed to be expired.
 */
let epoch = 1_000_000;

beforeEach(() => {
  mockS3Send.mockReset();
  vi.useFakeTimers();
  epoch += METADATA_KEYS_TTL * 5; // 5× ensures cache is expired even after tests that advance to epoch+TTL+1
  vi.setSystemTime(epoch);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// getMetadataKeys
// ---------------------------------------------------------------------------

describe("getMetadataKeys", () => {
  it("fetches keys from S3 on first call", async () => {
    mockS3Send.mockResolvedValueOnce(s3BodyFor(["FAC115.pdf", "FAC111.pdf"]));
    const keys = await getMetadataKeys();
    expect(keys).toEqual(["FAC115.pdf", "FAC111.pdf"]);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it("returns cached result within TTL without re-fetching S3", async () => {
    mockS3Send.mockResolvedValue(s3BodyFor(["doc1.pdf"]));
    await getMetadataKeys();                            // populates cache at `epoch`
    vi.setSystemTime(epoch + METADATA_KEYS_TTL / 2);   // still within TTL
    await getMetadataKeys();                            // should hit cache
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it("re-fetches from S3 after TTL expires", async () => {
    mockS3Send.mockResolvedValue(s3BodyFor(["doc1.pdf"]));
    await getMetadataKeys();
    vi.setSystemTime(epoch + METADATA_KEYS_TTL + 1);   // past TTL
    await getMetadataKeys();
    expect(mockS3Send).toHaveBeenCalledTimes(2);
  });

  it("returns null when S3 fetch fails", async () => {
    mockS3Send.mockRejectedValueOnce(new Error("AccessDenied"));
    const keys = await getMetadataKeys();
    expect(keys).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveDocumentName
// ---------------------------------------------------------------------------

describe("resolveDocumentName", () => {
  it("returns exact match (case-insensitive)", async () => {
    mockS3Send.mockResolvedValueOnce(s3BodyFor(["FAC115.pdf", "FAC111.pdf"]));
    expect(await resolveDocumentName("fac115.pdf")).toBe("FAC115.pdf");
  });

  it("returns fuzzy match when no exact match exists", async () => {
    mockS3Send.mockResolvedValueOnce(s3BodyFor(["FAC115 CUG.pdf", "FAC111.pdf"]));
    expect(await resolveDocumentName("FAC115")).toBe("FAC115 CUG.pdf");
  });

  it("exact match takes priority over fuzzy match", async () => {
    // Both "FAC115.pdf" and "FAC115 Amendment.pdf" contain "fac115" as a substring;
    // exact match on "FAC115.pdf" must win.
    mockS3Send.mockResolvedValueOnce(s3BodyFor(["FAC115.pdf", "FAC115 Amendment.pdf"]));
    expect(await resolveDocumentName("FAC115.pdf")).toBe("FAC115.pdf");
  });

  it("returns original name when no match found in keys", async () => {
    mockS3Send.mockResolvedValueOnce(s3BodyFor(["FAC115.pdf", "FAC111.pdf"]));
    expect(await resolveDocumentName("UNKNOWN.pdf")).toBe("UNKNOWN.pdf");
  });

  it("returns original name when S3 fetch fails (null keys)", async () => {
    mockS3Send.mockRejectedValueOnce(new Error("S3 error"));
    expect(await resolveDocumentName("doc.pdf")).toBe("doc.pdf");
  });
});
