import { Utils } from "../utils";
import { AppConfig } from "../types";
import { FeedbackSubmission } from "../../components/chatbot/types";

export class UserFeedbackClient {
  private readonly API;

  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  private async request(path: string, init: RequestInit = {}) {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
        ...(init.headers || {}),
      },
    });

    let body: any = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const message =
        typeof body === "string"
          ? body
          : body?.error || body?.message || "Request failed";
      throw new Error(message);
    }

    return body;
  }

  async submitFeedback(payload: FeedbackSubmission) {
    return this.request("/feedback", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async appendFeedbackFollowUp(feedbackId: string, payload: Partial<FeedbackSubmission>) {
    return this.request(`/feedback/${feedbackId}/follow-up`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getAdminFeedback(filters: Record<string, string | undefined> = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        params.set(key, value);
      }
    });
    return this.request(`/admin/feedback${params.toString() ? `?${params.toString()}` : ""}`, {
      method: "GET",
    });
  }

  async getAdminFeedbackDetail(feedbackId: string) {
    return this.request(`/admin/feedback/${feedbackId}`, { method: "GET" });
  }

  async analyzeFeedback(feedbackId: string) {
    return this.request(`/admin/feedback/${feedbackId}/analyze`, { method: "POST" });
  }

  async setFeedbackDisposition(
    feedbackId: string,
    payload: {
      reviewStatus: string;
      disposition: string;
      owner?: string;
      resolutionNote?: string;
      adminNotes?: string;
    }
  ) {
    return this.request(`/admin/feedback/${feedbackId}/disposition`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async promoteToCandidate(feedbackId: string) {
    return this.request(`/admin/feedback/${feedbackId}/promote-to-candidate`, {
      method: "POST",
    });
  }

  async getPrompts() {
    return this.request("/admin/prompts", { method: "GET" });
  }

  async getPrompt(versionId: string) {
    return this.request(`/admin/prompts/${versionId}`, { method: "GET" });
  }

  async createPrompt(payload: {
    title: string;
    notes?: string;
    template?: string;
    parentVersionId?: string;
    linkedFeedbackIds?: string[];
    aiSummary?: string;
  }) {
    return this.request("/admin/prompts", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async updatePrompt(
    versionId: string,
    payload: {
      title?: string;
      notes?: string;
      template?: string;
      linkedFeedbackIds?: string[];
    }
  ) {
    return this.request(`/admin/prompts/${versionId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  async publishPrompt(versionId: string) {
    return this.request(`/admin/prompts/${versionId}/publish`, {
      method: "POST",
    });
  }

  async aiSuggestPrompt(versionId: string, payload: { feedbackIds?: string[]; note?: string }) {
    return this.request(`/admin/prompts/${versionId}/ai-suggest`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getMonitoring() {
    return this.request("/admin/monitoring", { method: "GET" });
  }

  async getActivityLog() {
    return this.request("/admin/activity-log", { method: "GET" });
  }
}
