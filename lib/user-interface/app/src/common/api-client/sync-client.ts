import { Utils } from "../utils";
import { AppConfig } from "../types";

export interface SyncSchedule {
  scheduleExpression: string;
  state: string;
  enabled: boolean;
  dayOfWeek?: string;
  hourUtc?: number;
  minute?: number;
  humanReadable?: string;
}

export interface SyncDestination {
  stagingBucket: string;
  kbDocuments: {
    path: string;
    stagedCount: number;
  };
  indexes: Array<{
    indexName: string;
    displayName: string;
    path: string;
  }>;
}

export interface SyncRun {
  pk: string;
  sk: string;
  status: string;
  kbDocsCount: number;
  indexFilesCount: number;
  durationMs: number;
  error?: string;
}

export interface SyncHistory {
  runs: SyncRun[];
}

export class SyncClient {
  private readonly API: string;

  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  async getSyncSchedule(): Promise<SyncSchedule> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/sync-schedule", {
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
    });
    if (!response.ok) throw new Error("Failed to get sync schedule");
    return response.json();
  }

  async updateSyncSchedule(
    dayOfWeek: string,
    hourUtc: number,
    minute: number,
    enabled = true
  ): Promise<SyncSchedule> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/sync-schedule", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({ dayOfWeek, hourUtc, minute, enabled }),
    });
    if (!response.ok) throw new Error("Failed to update sync schedule");
    return response.json();
  }

  async getSyncDestinations(): Promise<SyncDestination> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/sync-destinations", {
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
    });
    if (!response.ok) throw new Error("Failed to get sync destinations");
    return response.json();
  }

  async getSyncHistory(limit = 20): Promise<SyncHistory> {
    const auth = await Utils.authenticate();
    const response = await fetch(
      this.API + `/admin/sync-history?limit=${limit}`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
      }
    );
    if (!response.ok) throw new Error("Failed to get sync history");
    return response.json();
  }

  async triggerSyncNow(): Promise<{ status: string }> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + "/admin/sync-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
    });
    if (!response.ok) throw new Error("Failed to trigger sync");
    return response.json();
  }
}
