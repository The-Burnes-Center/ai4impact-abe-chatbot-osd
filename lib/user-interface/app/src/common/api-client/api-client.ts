/**
 * ApiClient -- Facade over all REST API sub-clients.
 *
 * Rather than importing individual service clients throughout the app,
 * consumers create a single `ApiClient` instance (passing the runtime
 * `AppConfig`) and access domain-specific clients via property getters
 * (e.g. `apiClient.sessions`, `apiClient.knowledgeManagement`).
 *
 * Each sub-client is **lazily instantiated** on first access and then
 * cached for the lifetime of the `ApiClient` instance. This avoids
 * allocating HTTP clients or reading config for services the current
 * page does not need.
 */
import { AppConfig } from "../types";
import { SessionsClient } from "./sessions-client";
import { KnowledgeManagementClient } from "./knowledge-management-client";
import { UserFeedbackClient } from "./user-feedback-client";
import { MetricClient } from "./metrics-client";
import { EvaluationsClient } from "./evaluations-client";
import { ExcelIndexClient } from "./excel-index-client";
import { SyncClient } from "./sync-client";

export class ApiClient {

  // ---------------------------------------------------------------
  // Lazily-initialized sub-client backing fields.
  // Each is `undefined` until the corresponding getter is called for
  // the first time, at which point the sub-client is constructed with
  // the shared `_appConfig` and cached here.
  // ---------------------------------------------------------------

  private _sessionsClient: SessionsClient | undefined;

  private _knowledgeManagementClient : KnowledgeManagementClient | undefined;
  private _userFeedbackClient: UserFeedbackClient | undefined;
  private _metricClient: MetricClient | undefined;
  private _evaluationsClient: EvaluationsClient | undefined;
  private _excelIndexClient: ExcelIndexClient | undefined;
  private _syncClient: SyncClient | undefined;



  /** Lazily construct and cache the Knowledge Management sub-client. */
  public get knowledgeManagement() {
    if (!this._knowledgeManagementClient) {
      this._knowledgeManagementClient = new KnowledgeManagementClient(this._appConfig);      
    }

    return this._knowledgeManagementClient;
  }

  /** Lazily construct and cache the Sessions sub-client. */
  public get sessions() {
    if (!this._sessionsClient) {
      this._sessionsClient = new SessionsClient(this._appConfig);
    }

    return this._sessionsClient;
  }


  /** Lazily construct and cache the User Feedback sub-client. */
  public get userFeedback() {
    if (!this._userFeedbackClient) {
      this._userFeedbackClient = new UserFeedbackClient(this._appConfig);
    }

    return this._userFeedbackClient;
  }
  /** Lazily construct and cache the Evaluations sub-client. */
  public get evaluations() {
    if (!this._evaluationsClient) {
      this._evaluationsClient = new EvaluationsClient(this._appConfig);
    }

    return this._evaluationsClient;
  }
  /** Lazily construct and cache the Metrics sub-client. */
  public get metrics() {
    if (!this._metricClient) {
      this._metricClient = new MetricClient(this._appConfig);
    }

    return this._metricClient; //
  }

  /** Lazily construct and cache the Excel Index sub-client. */
  public get excelIndex() {
    if (!this._excelIndexClient) {
      this._excelIndexClient = new ExcelIndexClient(this._appConfig);
    }
    return this._excelIndexClient;
  }

  /** Lazily construct and cache the Sync sub-client. */
  public get sync() {
    if (!this._syncClient) {
      this._syncClient = new SyncClient(this._appConfig);
    }
    return this._syncClient;
  }

  /**
   * @param _appConfig Runtime configuration (API endpoints, region, etc.)
   *   shared with every sub-client created by this facade.
   */
  constructor(protected _appConfig: AppConfig) {}
}
