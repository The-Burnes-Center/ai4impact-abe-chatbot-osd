/**
 * @module kb
 *
 * Knowledge Base retrieval helpers for the ABE chat agent.
 *
 * Provides two retrieval strategies against the Bedrock Knowledge Base
 * (backed by OpenSearch Serverless with Titan Embed v2):
 *
 *  - {@link retrieveKBDocs} -- hybrid vector search returning the top-scoring
 *    chunks across all documents (diversified per document). Used by the
 *    `query_db` tool for broad information retrieval.
 *
 *  - {@link retrieveFullDocument} -- targeted retrieval of *every* chunk
 *    belonging to a single document, identified by filename. Used by the
 *    `retrieve_full_document` tool when the model needs the complete text
 *    of a Contract User Guide or policy document.
 *
 * Both functions return pre-signed S3 URLs (1-hour expiry) so the frontend
 * can render inline source links, and Bedrock-compatible `documentBlocks`
 * that enable native citation tracking in the model response.
 *
 * Supporting utilities handle metadata-key caching ({@link getMetadataKeys})
 * and fuzzy filename resolution ({@link resolveDocumentName}).
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { RetrieveCommand as KBRetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { cleanExcerptText } from "./citations.mjs";

const s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

/** @type {string[]|null} Cached array of document filenames from metadata.txt. */
let _metadataKeysCache = null;
/** @type {number} Epoch ms when the cache was last populated. */
let _metadataKeysCacheTs = 0;
/** Cache TTL in milliseconds (60 seconds). */
export const METADATA_KEYS_TTL = 60_000;

/**
 * Return the list of document filenames present in the knowledge bucket's
 * `metadata.txt` file.
 *
 * Results are cached in-process for {@link METADATA_KEYS_TTL} (60 s) to avoid
 * redundant S3 reads during a single Lambda invocation while still picking up
 * newly synced documents within a reasonable window. The cache lives in module
 * scope so it persists across warm-start invocations but is automatically
 * refreshed after the TTL expires.
 *
 * Used by {@link resolveDocumentName} to match user-supplied filenames against
 * the actual filenames in the knowledge base.
 *
 * @returns {Promise<string[]|null>} Array of filename keys, or `null` on error.
 */
export async function getMetadataKeys() {
  const now = Date.now();
  if (_metadataKeysCache && now - _metadataKeysCacheTs < METADATA_KEYS_TTL) return _metadataKeysCache;
  try {
    const resp = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.KNOWLEDGE_BUCKET,
      Key: "metadata.txt",
    }));
    const body = await resp.Body.transformToString();
    _metadataKeysCache = Object.keys(JSON.parse(body));
    _metadataKeysCacheTs = now;
    return _metadataKeysCache;
  } catch (e) {
    console.warn("Failed to load metadata.txt for filename resolution:", e);
    return null;
  }
}

/**
 * Resolve a user-supplied document name to the canonical filename in the KB.
 *
 * Uses a two-pass fuzzy matching strategy against the cached metadata keys:
 *  1. **Exact match** (case-insensitive) -- e.g. "fac115 cug.pdf" matches
 *     "FAC115 CUG.pdf".
 *  2. **Substring match** (case-insensitive) -- e.g. "FAC115" matches
 *     "FAC115 CUG.pdf" because the input is contained within the key. The
 *     system-generated `metadata.txt` inventory file is skipped in this pass
 *     (e.g. "data" would otherwise match "meta**data**.txt"); an explicit,
 *     exact request for "metadata.txt" still resolves via pass 1.
 *
 * If neither pass finds a match, the original input is returned unchanged and
 * the downstream KB filter will attempt its own matching (which may return
 * zero results if the name is wrong).
 *
 * @param {string} documentName - The filename (or partial filename) supplied
 *   by the model's tool call.
 * @returns {Promise<string>} The best-matching canonical filename, or the
 *   original input if no match is found.
 */
export async function resolveDocumentName(documentName) {
  const keys = await getMetadataKeys();
  if (!keys) return documentName;
  const lower = documentName.toLowerCase();
  const exact = keys.find(k => k.toLowerCase() === lower);
  if (exact) return exact;
  const fuzzy = keys.find(k => {
    const keyLower = k.toLowerCase();
    return keyLower !== "metadata.txt" && keyLower.includes(lower);
  });
  return fuzzy || documentName;
}

export const CONTENT_TYPE_MAP = {
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

/**
 * Return the S3 URI of the knowledge bucket's system-generated `metadata.txt`
 * inventory file, used to exclude it from KB retrieval.
 *
 * @returns {string|null} `s3://<bucket>/metadata.txt`, or `null` when the
 *   `KNOWLEDGE_BUCKET` environment variable is unset.
 */
export function metadataTxtUri() {
  const bucket = process.env.KNOWLEDGE_BUCKET;
  return bucket ? `s3://${bucket}/metadata.txt` : null;
}

/**
 * Compose the Bedrock RetrievalFilter for KB vector search.
 *
 * Two optional clauses are combined:
 *  - **within** -- when `withinDocument` is a non-empty string, restrict
 *    results to chunks whose source URI contains it (same `stringContains`
 *    shape used by {@link retrieveFullDocument}).
 *  - **exclusion** -- when {@link metadataTxtUri} is available, exclude the
 *    system-generated `metadata.txt` inventory file via `notEquals` on the
 *    full source URI (Bedrock has no `stringNotContains` operator).
 *
 * @param {{withinDocument?: string}} [options] - Optional scoping parameters.
 * @returns {object|undefined} `undefined` when neither clause applies, the
 *   bare filter when exactly one applies, or `{ andAll: [within, exclusion] }`
 *   when both apply (`andAll` requires at least 2 members).
 */
export function buildKbFilter({ withinDocument } = {}) {
  const clauses = [];
  if (typeof withinDocument === "string" && withinDocument.length > 0) {
    clauses.push({
      stringContains: { key: "x-amz-bedrock-kb-source-uri", value: withinDocument },
    });
  }
  const excludeUri = metadataTxtUri();
  if (excludeUri) {
    clauses.push({
      notEquals: { key: "x-amz-bedrock-kb-source-uri", value: excludeUri },
    });
  }
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { andAll: clauses };
}

/**
 * Determine whether a Bedrock retrieval result came from the system-generated
 * `metadata.txt` inventory file (matched on the basename of the source URI,
 * case-insensitively).
 *
 * @param {object} item - A Bedrock retrieval result.
 * @returns {boolean} `true` when the result's source file is `metadata.txt`.
 */
export function isMetadataTxtResult(item) {
  const uri = item?.location?.s3Location?.uri;
  if (!uri) return false;
  const baseName = uri.split("/").pop() || "";
  return baseName.toLowerCase() === "metadata.txt";
}

/**
 * Retrieve relevant document chunks from the Bedrock Knowledge Base via
 * hybrid (semantic + keyword) search.
 *
 * Fetches up to 25 results per page and eagerly fetches one additional page
 * (if available) for broader coverage, yielding up to 50 candidate chunks.
 * No absolute score threshold is applied: hybrid search scores are not
 * normalized to a 0-1 scale (observed values run ~1.3-1.6), so the historical
 * 0.6 confidence cut-off was a no-op. Result diversification instead happens
 * via the per-document cap (`PER_DOC_CAP`), which keeps one document from
 * crowding out others. The system-generated `metadata.txt` inventory file --
 * also ingested into the KB -- is excluded both server-side (a `notEquals`
 * retrieval filter on its source URI, see {@link buildKbFilter}) and via a
 * defensive post-filter ({@link isMetadataTxtResult}).
 *
 * For each passing chunk, a pre-signed S3 URL (1-hour expiry) is generated
 * so the frontend can link directly to the source PDF. URLs are cached per
 * S3 key within the call to avoid redundant signing when multiple chunks
 * come from the same document.
 *
 * @param {string} query - The user's search query.
 * @param {import("@aws-sdk/client-bedrock-agent-runtime").BedrockAgentRuntimeClient} knowledgeBase
 *   The Bedrock Agent Runtime client.
 * @param {string} knowledgeBaseID - The Bedrock Knowledge Base ID.
 * @param {number} [startIndex=0] - Offset for citation numbering (used when
 *   this call follows a previous retrieval in the same turn).
 * @param {{withinDocument?: string}} [options] - Optional scoping parameters.
 *   When `withinDocument` is a non-empty string, it is resolved via
 *   {@link resolveDocumentName} (fuzzy filename matching, same as
 *   `retrieve_full_document`) and the search is restricted to chunks whose
 *   source URI contains the resolved name. When resolution fails, the raw
 *   string is used as-is (the `stringContains` filter still matches partial
 *   URIs).
 * @returns {Promise<{content: string, sources: object[], documentBlocks: object[]}>}
 *   `content` is empty on success (the model reads `documentBlocks`), or an
 *   error/fallback message. `sources` powers the frontend citation sidebar.
 *   `documentBlocks` are Bedrock-format document blocks with citations enabled.
 */
export async function retrieveKBDocs(query, knowledgeBase, knowledgeBaseID, startIndex = 0, options = {}) {
  let withinDocument = null;
  if (typeof options.withinDocument === "string" && options.withinDocument.length > 0) {
    // resolveDocumentName returns the input unchanged when no match is found,
    // so a failed resolution falls back to the raw string.
    withinDocument = await resolveDocumentName(options.withinDocument);
    if (withinDocument !== options.withinDocument) {
      console.log(`query_db: resolved within_document "${options.withinDocument}" → "${withinDocument}"`);
    }
  }
  const filter = buildKbFilter(withinDocument ? { withinDocument } : {});
  const input = {
    knowledgeBaseId: knowledgeBaseID,
    retrievalQuery: { text: query },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: 25,
        ...(filter ? { filter } : {}),
        // HYBRID (semantic + keyword) rather than pure semantic. A bare
        // identifier like a contract or RFR number ("ITS88") embeds almost
        // identically to every "ITS##" sibling, so pure semantic search ranks
        // the siblings near-equally and pushes the target document below the
        // numberOfResults cutoff — making a document findable by its content
        // but NOT by its number, even though it's fully indexed. The keyword
        // channel of hybrid search matches the exact token and floats the
        // document's own chunks to the top.
        overrideSearchType: "HYBRID",
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

    // Defensive post-filter: the server-side notEquals filter should already
    // exclude metadata.txt, but covers deployments where KNOWLEDGE_BUCKET is
    // unset or the URI differs from the constructed one.
    const passingResults = allResults.filter(item => !isMetadataTxtResult(item));

    // Per-document diversification: one highly-relevant document (e.g. a CUG)
    // can saturate the top-25 chunks and crowd out other documents that may
    // contain the actual answer (e.g. the matching RFR / solicitation /
    // amendment). We cap each source file's contribution so a wider set of
    // files surfaces in the first-turn results. Results are pre-sorted by
    // descending score, so we keep the highest-scoring chunks per document.
    const PER_DOC_CAP = 5;
    passingResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const perDocCount = new Map();
    const confidenceFilteredResults = [];
    for (const item of passingResults) {
      const uri = item.location?.s3Location?.uri || "";
      const count = perDocCount.get(uri) || 0;
      if (count >= PER_DOC_CAP) continue;
      perDocCount.set(uri, count + 1);
      confidenceFilteredResults.push(item);
    }

    if (confidenceFilteredResults.length === 0) {
      console.log("Warning: no relevant sources found");
      return {
        content: withinDocument
          ? `No results found within document "${withinDocument}" for this query. Retry without within_document to search the whole knowledge base.`
          : `No knowledge available! This query is likely outside the scope of your knowledge.
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
 *
 * Unlike {@link retrieveKBDocs} which performs a broad semantic search, this
 * function targets a single document using a `stringContains` metadata filter
 * on the `x-amz-bedrock-kb-source-uri` field. It then paginates through
 * **all** result pages (via `nextToken`) so the model receives the complete
 * document content with no truncation. This is critical for Contract User
 * Guides where partial retrieval can miss key terms or pricing details.
 *
 * Pagination approach: requests up to 100 results per page and loops until
 * `nextToken` is exhausted. For a typical 20-page CUG with ~40 chunks, this
 * completes in one or two pages. Results are sorted by page number after
 * collection so the model reads the document in natural order.
 *
 * The document name is first resolved via {@link resolveDocumentName} for
 * fuzzy matching (e.g. "FAC115" -> "FAC115 CUG.pdf").
 *
 * @param {string} documentName - Filename or partial filename from the model's
 *   tool call.
 * @param {import("@aws-sdk/client-bedrock-agent-runtime").BedrockAgentRuntimeClient} knowledgeBase
 *   The Bedrock Agent Runtime client.
 * @param {string} knowledgeBaseID - The Bedrock Knowledge Base ID.
 * @param {string} [queryContext] - Optional query string used as the retrieval
 *   query to help rank chunks by relevance. Falls back to the resolved
 *   filename if not provided.
 * @param {number} [startIndex=0] - Offset for citation numbering.
 * @returns {Promise<{content: string, sources: object[], documentBlocks: object[]}>}
 *   Same shape as {@link retrieveKBDocs}. `content` is empty on success.
 */
export async function retrieveFullDocument(documentName, knowledgeBase, knowledgeBaseID, queryContext, startIndex = 0) {
  const resolvedName = await resolveDocumentName(documentName);
  if (resolvedName !== documentName) {
    console.log(`retrieve_full_document: resolved "${documentName}" → "${resolvedName}"`);
  }
  const retrievalQuery = queryContext || resolvedName;
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
                value: resolvedName,
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
