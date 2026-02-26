import { AppConfig } from "../types";
import { SessionsClient } from "./sessions-client";
import { KnowledgeManagementClient } from "./knowledge-management-client";
import { UserFeedbackClient } from "./user-feedback-client";
import { MetricClient } from "./metrics-client";
import { EvaluationsClient } from "./evaluations-client";
import { ContractIndexClient } from "./contract-index-client";
import { TradeIndexClient } from "./trade-index-client";

export class ApiClient {

  private _sessionsClient: SessionsClient | undefined;

  private _knowledgeManagementClient : KnowledgeManagementClient | undefined;
  private _userFeedbackClient: UserFeedbackClient | undefined;
  private _metricClient: MetricClient | undefined;
  private _evaluationsClient: EvaluationsClient | undefined;
  private _contractIndexClient: ContractIndexClient | undefined;
  private _tradeIndexClient: TradeIndexClient | undefined;

 

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

  public get contractIndex() {
    if (!this._contractIndexClient) {
      this._contractIndexClient = new ContractIndexClient(this._appConfig);
    }
    return this._contractIndexClient;
  }

  public get tradeIndex() {
    if (!this._tradeIndexClient) {
      this._tradeIndexClient = new TradeIndexClient(this._appConfig);
    }
    return this._tradeIndexClient;
  }

  constructor(protected _appConfig: AppConfig) {}
}
