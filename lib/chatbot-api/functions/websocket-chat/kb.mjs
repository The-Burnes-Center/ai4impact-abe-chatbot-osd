import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { RetrieveCommand as KBRetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { cleanExcerptText } from "./citations.mjs";

const s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

let _metadataKeysCache = null;
let _metadataKeysCacheTs = 0;
export const METADATA_KEYS_TTL = 60_000;

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

export async function resolveDocumentName(documentName) {
  const keys = await getMetadataKeys();
  if (!keys) return documentName;
  const lower = documentName.toLowerCase();
  const exact = keys.find(k => k.toLowerCase() === lower);
  if (exact) return exact;
  const fuzzy = keys.find(k => k.toLowerCase().includes(lower));
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

export async function retrieveKBDocs(query, knowledgeBase, knowledgeBaseID, startIndex = 0) {
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
      item.score > 0.6
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
