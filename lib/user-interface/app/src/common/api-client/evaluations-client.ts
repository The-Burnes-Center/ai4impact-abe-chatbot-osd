import { Utils } from "../utils";
import { AppConfig } from "../types";

export class EvaluationsClient {
  private readonly API;
  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  async getEvaluationSummaries(continuationToken?: any, limit: number = 10) {
    try {
      const auth = await Utils.authenticate();
      const body: any = {
        operation: "get_evaluation_summaries",
        limit,
      };
      if (continuationToken) {
        body.continuation_token = continuationToken;
      }

      const response = await fetch(`${this.API}/eval-results-handler`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: JSON.stringify(body),
      });

      if (response.status === 404) {
        return { Items: [], NextPageToken: null };
      }
      if (!response.ok) {
        const errorText = await response.text();
        if (
          errorText.includes("ResourceNotFoundException") ||
          errorText.includes("ValidationException")
        ) {
          return { Items: [], NextPageToken: null };
        }
        throw new Error(`Failed to get evaluation summaries: ${response.status}`);
      }

      const result = await response.json();
      return result.Items ? result : { Items: [], NextPageToken: null };
    } catch (error) {
      throw error;
    }
  }

  async getEvaluationResults(
    evaluationId: string,
    continuationToken?: any,
    limit: number = 10
  ) {
    try {
      const auth = await Utils.authenticate();
      const body: any = {
        operation: "get_evaluation_results",
        evaluation_id: evaluationId,
        limit,
      };
      if (continuationToken) {
        body.continuation_token = continuationToken;
      }

      const response = await fetch(`${this.API}/eval-results-handler`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return { Items: [], NextPageToken: null };
      }

      const result = await response.json();
      return result.Items ? result : { Items: [], NextPageToken: null };
    } catch {
      return { Items: [], NextPageToken: null };
    }
  }

  async startNewEvaluation(
    evaluationName: string,
    testCaseFile?: string,
    testCasesInline?: Array<{ question: string; expectedResponse: string }>
  ) {
    const auth = await Utils.authenticate();
    const body: any = { evaluation_name: evaluationName };
    if (testCaseFile) body.testCasesKey = testCaseFile;
    if (testCasesInline) body.testCasesInline = testCasesInline;

    const response = await fetch(`${this.API}/eval-run-handler`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to start evaluation: ${response.status} - ${errorText}`);
    }
    return response.json();
  }

  async getEvalStatus(evaluationId: string) {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/eval-results-handler`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({
        operation: "get_eval_status",
        evaluation_id: evaluationId,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to get eval status: ${response.status}`);
    }
    return response.json();
  }

  async getUploadURL(fileName: string, fileType: string): Promise<string> {
    if (!fileType) throw new Error("Must have valid file type!");
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/signed-url-test-cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({ fileName, fileType }),
    });
    if (!response.ok) throw new Error("Failed to get upload URL");
    const data = await response.json();
    return data.signedUrl;
  }

  async getDocuments(continuationToken?: string, pageIndex?: number) {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/s3-test-cases-bucket-data`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({ continuationToken, pageIndex }),
    });
    if (!response.ok) throw new Error("Failed to get files");
    return response.json();
  }

  // --- Test Library ---
  async listTestLibrary(search?: string, continuationToken?: any, limit = 25) {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/test-library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "list",
        search,
        continuation_token: continuationToken,
        limit,
      }),
    });
    if (!response.ok) throw new Error("Failed to list test library");
    return response.json();
  }

  async getTestLibraryItem(questionId: string) {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/test-library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ operation: "get", question_id: questionId }),
    });
    if (!response.ok) throw new Error("Failed to get test library item");
    return response.json();
  }

  async createTestLibraryItem(question: string, expectedResponse: string) {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/test-library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ operation: "create", question, expectedResponse }),
    });
    if (!response.ok) throw new Error("Failed to create test library item");
    return response.json();
  }

  async updateTestLibraryItem(questionId: string, expectedResponse: string) {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/test-library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "update",
        question_id: questionId,
        expectedResponse,
      }),
    });
    if (!response.ok) throw new Error("Failed to update test library item");
    return response.json();
  }

  async revertTestLibraryItem(questionId: string, versionIndex: number) {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/test-library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "revert",
        question_id: questionId,
        version_index: versionIndex,
      }),
    });
    if (!response.ok) throw new Error("Failed to revert test library item");
    return response.json();
  }

  async deleteTestLibraryItem(questionId: string) {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/test-library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ operation: "delete", question_id: questionId }),
    });
    if (!response.ok) throw new Error("Failed to delete test library item");
    return response.json();
  }

  async bulkImportTestLibrary(
    items: Array<{ question: string; expectedResponse: string }>,
    source = "import"
  ) {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/test-library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ operation: "bulk_import", items, source }),
    });
    if (!response.ok) throw new Error("Failed to bulk import");
    return response.json();
  }

  async exportTestLibrary() {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/test-library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ operation: "export" }),
    });
    if (!response.ok) throw new Error("Failed to export test library");
    return response.json();
  }

  async getTestLibraryStats() {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/test-library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ operation: "stats" }),
    });
    if (!response.ok) throw new Error("Failed to get test library stats");
    return response.json();
  }
}
