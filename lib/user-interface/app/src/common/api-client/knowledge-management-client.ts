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
        let serverMessage: string | undefined;
        try {
          const errorBody = await response.json();
          serverMessage = errorBody?.error || errorBody?.message;
        } catch {
          // Response body wasn't JSON; fall through to generic message.
        }
        throw new Error(serverMessage ?? 'Failed to get upload URL.');
      }

      const data = await response.json();
      return data.signedUrl;
    } catch (error) {
      if (import.meta.env.DEV) console.error("Error:", error);
      throw error;
    }
  }

  // Returns a list of documents in the S3 bucket (hard-coded on the backend)
  async getDocuments(continuationToken?: string, pageIndex?: number) {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/s3-bucket-data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization' : auth
      },
      body: JSON.stringify({
        continuationToken: continuationToken,
        pageIndex: pageIndex,
      }),
    });
    if (!response.ok) {
      throw new Error('Failed to get files');
    }
    const result = await response.json();
    return result;
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
      throw new Error('Failed to delete file');
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
      throw new Error('Failed to sync');
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
      throw new Error('Failed to check sync status');
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
      throw new Error('Failed to check last status');
    }
    return await response.json()
  }

  
}
