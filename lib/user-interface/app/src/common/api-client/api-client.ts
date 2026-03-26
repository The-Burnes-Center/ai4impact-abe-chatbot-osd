import { AppConfig } from "../types";
import { SessionsClient } from "./sessions-client";
import { KnowledgeManagementClient } from "./knowledge-management-client";
import { UserFeedbackClient } from "./user-feedback-client";
import { MetricClient } from "./metrics-client";
import { EvaluationsClient } from "./evaluations-client";
import { ExcelIndexClient } from "./excel-index-client";
import { SyncClient } from "./sync-client";

export class ApiClient {

  private _sessionsClient: SessionsClient | undefined;

  private _knowledgeManagementClient : KnowledgeManagementClient | undefined;
  private _userFeedbackClient: UserFeedbackClient | undefined;
  private _metricClient: MetricClient | undefined;
  private _evaluationsClient: EvaluationsClient | undefined;
  private _excelIndexClient: ExcelIndexClient | undefined;
  private _syncClient: SyncClient | undefined;

 

  /** Construct the Knowledge Management sub-client */
  public get knowledgeManagement() {
    if (!this._knowledgeManagementClient) {
      this._knowledgeManagementClient = new KnowledgeManagementClient(this._appConfig);      
    }

    return this._knowledgeManagementClient;
  }

  /** Construct the Sessions sub-client */
  public get sessions() {
    if (!this._sessionsClient) {
      this._sessionsClient = new SessionsClient(this._appConfig);
    }

    return this._sessionsClient;
  }


  /** Construct the Feedback sub-client */
  public get userFeedback() {
    if (!this._userFeedbackClient) {
      this._userFeedbackClient = new UserFeedbackClient(this._appConfig);
    }

    return this._userFeedbackClient;
  }
  /** Construct the Evaluations sub-client */
  public get evaluations() {
    if (!this._evaluationsClient) {
      this._evaluationsClient = new EvaluationsClient(this._appConfig);
    }

    return this._evaluationsClient;
  }
  public get metrics() {
    if (!this._metricClient) {
      this._metricClient = new MetricClient(this._appConfig);
    }

    return this._metricClient; //
  }

  public get excelIndex() {
    if (!this._excelIndexClient) {
      this._excelIndexClient = new ExcelIndexClient(this._appConfig);
    }
    return this._excelIndexClient;
  }

  public get sync() {
    if (!this._syncClient) {
      this._syncClient = new SyncClient(this._appConfig);
    }
    return this._syncClient;
  }

  constructor(protected _appConfig: AppConfig) {}
}
