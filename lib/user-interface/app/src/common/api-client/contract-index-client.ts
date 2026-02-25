import { Utils } from "../utils";
import { AppConfig } from "../types";

export interface ContractIndexStatus {
  has_data: boolean;
  row_count: number;
  last_updated: string | null;
  error_message: string | null;
}

export interface ContractIndexPreview {
  columns: string[];
  rows: Record<string, unknown>[];
}

export class ContractIndexClient {
  private readonly API: string;

  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  async getStatus(): Promise<ContractIndexStatus> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/contract-index/status", {
      method: "GET",
      headers: { Authorization: auth },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = (body as { error?: string; message?: string })?.error ?? (body as { message?: string })?.message ?? `Failed to get contract index status (${response.status})`;
      throw new Error(msg);
    }
    return {
      has_data: body.has_data ?? false,
      row_count: body.row_count ?? 0,
      last_updated: body.last_updated ?? null,
      error_message: body.error_message ?? null,
    };
  }

  async getUploadUrl(): Promise<string> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/contract-index/upload-url", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = (data as { error?: string; message?: string })?.error ?? (data as { message?: string })?.message ?? `Failed to get upload URL (${response.status})`;
      throw new Error(msg);
    }
    return data.signedUrl;
  }

  async getPreview(): Promise<ContractIndexPreview> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/contract-index/preview", {
      method: "GET",
      headers: { Authorization: auth },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = (body as { error?: string; message?: string })?.error ?? (body as { message?: string })?.message ?? `Failed to get preview (${response.status})`;
      throw new Error(msg);
    }
    return {
      columns: body.columns ?? [],
      rows: body.rows ?? [],
    };
  }
}
