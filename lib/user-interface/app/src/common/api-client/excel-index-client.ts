import { Utils } from "../utils";
import { AppConfig } from "../types";

export type IndexStatusValue = "NO_DATA" | "PROCESSING" | "COMPLETE" | "ERROR";

export interface IndexStatus {
  status: IndexStatusValue;
  has_data: boolean;
  row_count: number;
  last_updated: string | null;
  error_message: string | null;
}

export interface IndexPreview {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface IndexInfo {
  index_name: string;
  display_name: string;
  description: string;
  columns: string[];
  row_count: number;
  last_updated: string | null;
  status: IndexStatusValue;
}

export class ExcelIndexClient {
  private readonly API: string;

  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  async listIndexes(): Promise<IndexInfo[]> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/indexes", {
      method: "GET",
      headers: { Authorization: auth },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        (body as { error?: string })?.error ??
        `Failed to list indexes (${response.status})`;
      throw new Error(msg);
    }
    return body.indexes ?? [];
  }

  async createIndex(
    indexName: string,
    displayName: string,
    description?: string
  ): Promise<{ index_name: string; display_name: string; description: string; status: string }> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/indexes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({ index_name: indexName, display_name: displayName, description: description || "" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        (body as { error?: string })?.error ??
        `Failed to create index (${response.status})`;
      throw new Error(msg);
    }
    return body;
  }

  async getStatus(indexId: string): Promise<IndexStatus> {
    const auth = await Utils.authenticate();
    const response = await fetch(
      this.API + `/admin/indexes/${encodeURIComponent(indexId)}/status`,
      { method: "GET", headers: { Authorization: auth } }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        (body as { error?: string; message?: string })?.error ??
        (body as { message?: string })?.message ??
        `Failed to get index status (${response.status})`;
      throw new Error(msg);
    }
    const status = body.status as IndexStatusValue | undefined;
    const validStatus: IndexStatusValue[] = [
      "NO_DATA",
      "PROCESSING",
      "COMPLETE",
      "ERROR",
    ];
    return {
      status: status && validStatus.includes(status) ? status : "NO_DATA",
      has_data: body.has_data ?? false,
      row_count: body.row_count ?? 0,
      last_updated: body.last_updated ?? null,
      error_message: body.error_message ?? null,
    };
  }

  async getUploadUrl(indexId: string): Promise<string> {
    const auth = await Utils.authenticate();
    const response = await fetch(
      this.API + `/admin/indexes/${encodeURIComponent(indexId)}/upload-url`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: JSON.stringify({}),
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        (data as { error?: string })?.error ??
        `Failed to get upload URL (${response.status})`;
      throw new Error(msg);
    }
    return data.signedUrl;
  }

  async getPreview(indexId: string): Promise<IndexPreview> {
    const auth = await Utils.authenticate();
    const response = await fetch(
      this.API + `/admin/indexes/${encodeURIComponent(indexId)}/preview`,
      { method: "GET", headers: { Authorization: auth } }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        (body as { error?: string; message?: string })?.error ??
        (body as { message?: string })?.message ??
        `Failed to get preview (${response.status})`;
      throw new Error(msg);
    }
    return {
      columns: body.columns ?? [],
      rows: body.rows ?? [],
    };
  }

  async updateIndex(
    indexId: string,
    fields: { display_name?: string; description?: string }
  ): Promise<{ index_name: string; display_name: string; description: string }> {
    const auth = await Utils.authenticate();
    const response = await fetch(
      this.API + `/admin/indexes/${encodeURIComponent(indexId)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: JSON.stringify(fields),
      }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        (body as { error?: string })?.error ??
        `Failed to update index (${response.status})`;
      throw new Error(msg);
    }
    return body;
  }

  async deleteIndex(indexId: string): Promise<void> {
    const auth = await Utils.authenticate();
    const response = await fetch(
      this.API + `/admin/indexes/${encodeURIComponent(indexId)}`,
      { method: "DELETE", headers: { Authorization: auth } }
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const msg =
        (body as { error?: string })?.error ??
        `Failed to delete index (${response.status})`;
      throw new Error(msg);
    }
  }
}
