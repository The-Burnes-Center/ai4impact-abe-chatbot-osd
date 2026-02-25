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
    if (!response.ok) {
      throw new Error("Failed to get contract index status");
    }
    const body = await response.json();
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
    if (!response.ok) {
      throw new Error("Failed to get upload URL");
    }
    const data = await response.json();
    return data.signedUrl;
  }

  async getPreview(): Promise<ContractIndexPreview> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/contract-index/preview", {
      method: "GET",
      headers: { Authorization: auth },
    });
    if (!response.ok) {
      throw new Error("Failed to get preview");
    }
    const body = await response.json();
    return {
      columns: body.columns ?? [],
      rows: body.rows ?? [],
    };
  }
}
