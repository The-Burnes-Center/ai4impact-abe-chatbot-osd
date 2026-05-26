import {
  Utils
} from "../utils"

import { AppConfig } from "../types";

export interface SyncStatistics {
  scanned: number;
  indexed: number;
  modified: number;
  deleted: number;
  failed: number;
}

export interface SyncStatus {
  status: "STILL_SYNCING" | "DONE_SYNCING";
  statistics?: SyncStatistics;
}

export class KnowledgeManagementClient {

  private readonly API;
  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0,-1);
  }
  
  // Returns a URL from the this.API that allows one file upload to S3 with that exact filename
  async getUploadURL(fileName: string, fileType : string): Promise<string> {    
    if (!fileType) {
      throw new Error('Must have valid file type!');
    }

    try {
      const auth = await Utils.authenticate();
      const response = await fetch(this.API + '/signed-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization' : auth
        },
        body: JSON.stringify({ fileName, fileType })
      });

      if (!response.ok) {
        // Surface the backend's specific error (e.g. which character in the
        // filename was rejected) instead of swallowing it behind a generic
        // "Failed to get upload URL" — admins need to know what to fix.
        throw new Error(await Utils.extractServerError(response, 'Failed to get upload URL.'));
      }

      const data = await response.json();
      return data.signedUrl;
    } catch (error) {
      if (import.meta.env.DEV) console.error("Error:", error);
      throw error;
    }
  }

  // Fast path: lists every file in the KB bucket with metadata-presence
  // flags but no per-doc Bedrock sync status. The sync chips hydrate
  // separately via getSyncStatusMap() so the table can render in ~300-500ms
  // instead of blocking on Bedrock's paginated ListKnowledgeBaseDocuments.
  async getDocuments() {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/s3-bucket-data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
      },
      body: JSON.stringify({ mode: 'files' }),
    });
    if (!response.ok) {
      throw new Error(await Utils.extractServerError(response, 'Failed to load files.'));
    }
    return await response.json();
  }

  // Per-document sync status keyed by S3 key. The backend caches this for
  // 30s in the warm Lambda container, so repeat polls are effectively free.
  // Pass refresh=true to bypass the cache (e.g. right after a sync finishes).
  async getSyncStatusMap(
    refresh = false,
  ): Promise<{ syncStatus: Record<string, "synced" | "syncing" | "failed" | "not_yet_synced">; cached: boolean; ageMs: number }> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/s3-bucket-data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
      },
      body: JSON.stringify({ mode: 'syncStatus', refreshStatus: refresh }),
    });
    if (!response.ok) {
      throw new Error(await Utils.extractServerError(response, 'Failed to load sync status.'));
    }
    return await response.json();
  }

  // Deletes a given file on the S3 bucket (hardcoded on the backend!)
  async deleteFile(key : string) {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/delete-s3-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization' : auth
      },
      body: JSON.stringify({
        KEY : key
      }),
    });
    if (!response.ok) {
      // The Lambda returns specific messages (auth failures, KB cleanup
      // errors, etc.) -- propagate them so the admin sees *why* the delete
      // failed instead of a generic "Failed to delete file".
      throw new Error(await Utils.extractServerError(response, 'Failed to delete file.'));
    }
    return await response.json()
  }

  // Runs a sync job on Kendra (hardcoded datasource as well as index on the backend)
  async syncKendra() : Promise<string> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/kb-sync/sync-kb', {headers: {
      'Content-Type': 'application/json',
      'Authorization' : auth
    }})
    if (!response.ok) {
      throw new Error(await Utils.extractServerError(response, 'Failed to start sync.'));
    }
    return await response.json()
  }

  // Checks if Bedrock KB is currently syncing. Returns the live ingestion
  // job statistics while in-progress so the UI can show a progress percent.
  async kendraIsSyncing() : Promise<SyncStatus> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/kb-sync/still-syncing', {headers: {
      'Content-Type': 'application/json',
      'Authorization' : auth
    }})
    if (!response.ok) {
      throw new Error(await Utils.extractServerError(response, 'Failed to check sync status.'));
    }
    const raw = await response.json();
    // The Lambda historically returned a plain "STILL SYNCING" / "DONE SYNCING"
    // string. Accept that too so a partial deploy (frontend ahead of backend
    // or vice versa) doesn't blow up the admin page.
    if (typeof raw === 'string') {
      return { status: raw === 'DONE SYNCING' ? 'DONE_SYNCING' : 'STILL_SYNCING' };
    }
    return raw as SyncStatus;
  }

  // Checks the last time Kendra was synced
  async lastKendraSync() : Promise<{
    status: string;
    message?: string;
    startedAt: string | null;
    completedAt: string | null;
  }> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/kb-sync/get-last-sync', {headers: {
      'Content-Type': 'application/json',
      'Authorization' : auth
    }})
    if (!response.ok) {
      throw new Error(await Utils.extractServerError(response, 'Failed to load last sync time.'));
    }
    return await response.json()
  }


}
