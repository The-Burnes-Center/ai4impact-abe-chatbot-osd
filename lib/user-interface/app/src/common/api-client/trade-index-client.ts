import { Utils } from "../utils";
import { AppConfig } from "../types";

export type TradeIndexStatusValue = "NO_DATA" | "PROCESSING" | "COMPLETE" | "ERROR";

export interface TradeIndexStatus {
  status: TradeIndexStatusValue;
  has_data: boolean;
  row_count: number;
  last_updated: string | null;
  error_message: string | null;
}

export interface TradeIndexPreview {
  columns: string[];
  rows: Record<string, unknown>[];
}

export class TradeIndexClient {
  private readonly API: string;

  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  async getStatus(): Promise<TradeIndexStatus> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/trade-index/status", {
      method: "GET",
      headers: { Authorization: auth },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = (body as { error?: string; message?: string })?.error ?? (body as { message?: string })?.message ?? `Failed to get trade index status (${response.status})`;
      throw new Error(msg);
    }
    const status = body.status as TradeIndexStatusValue | undefined;
    const validStatus: TradeIndexStatusValue[] = ["NO_DATA", "PROCESSING", "COMPLETE", "ERROR"];
    return {
      status: status && validStatus.includes(status) ? status : "NO_DATA",
      has_data: body.has_data ?? false,
      row_count: body.row_count ?? 0,
      last_updated: body.last_updated ?? null,
      error_message: body.error_message ?? null,
    };
  }

  async getUploadUrl(): Promise<string> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/trade-index/upload-url", {
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

  async getPreview(): Promise<TradeIndexPreview> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/trade-index/preview", {
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
