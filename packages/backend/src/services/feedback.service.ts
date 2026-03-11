import type { FeedbackItem, FeedbackSubmitRequest } from "@opensprint/shared";
import { feedbackStore } from "./feedback-store.service.js";
import {
  FeedbackCategorizationService,
  type FeedbackCategorizationDeps,
} from "./feedback-categorization.service.js";
import {
  FeedbackTaskCreationService,
  deduplicateProposedTasks,
} from "./feedback-task-creation.service.js";
import { retryPendingCategorizations } from "./feedback-retry.service.js";
import { submitFeedback as submitFeedbackImpl } from "./feedback-submit.service.js";
import {
  resolveFeedback as resolveFeedbackImpl,
  checkAutoResolveOnTaskDone as checkAutoResolveOnTaskDoneImpl,
} from "./feedback-resolve.service.js";
import { cancelFeedback as cancelFeedbackImpl } from "./feedback-cancel.service.js";
import { processFeedbackWithAnalyst as processFeedbackWithAnalystImpl } from "./feedback-process.service.js";
import { recategorizeFeedback as recategorizeFeedbackImpl } from "./feedback-recategorize.service.js";

export class FeedbackService {
  private categorizationService: FeedbackCategorizationService;
  private taskCreationService: FeedbackTaskCreationService;

  constructor() {
    const deps: FeedbackCategorizationDeps = {
      enqueueForCategorization: (projectId, feedbackId) =>
        this.enqueueForCategorization(projectId, feedbackId),
      saveFeedback: (projectId, item) => this.saveFeedback(projectId, item),
      deduplicateProposedTasks,
    };
    this.categorizationService = new FeedbackCategorizationService(deps);
    this.taskCreationService = new FeedbackTaskCreationService();
  }

  async enqueueForCategorization(projectId: string, feedbackId: string): Promise<void> {
    await feedbackStore.enqueueForCategorization(projectId, feedbackId);
  }

  async getNextPendingFeedbackId(projectId: string): Promise<string | null> {
    return feedbackStore.getNextPendingFeedbackId(projectId);
  }

  async claimNextPendingFeedbackId(projectId: string): Promise<string | null> {
    return feedbackStore.claimNextPendingFeedbackId(projectId);
  }

  async removeFromInbox(projectId: string, feedbackId: string): Promise<void> {
    await feedbackStore.removeFromInbox(projectId, feedbackId);
  }

  async listPendingFeedbackIds(projectId: string): Promise<string[]> {
    return feedbackStore.listPendingFeedbackIds(projectId);
  }

  async processFeedbackWithAnalyst(projectId: string, feedbackId: string): Promise<void> {
    return processFeedbackWithAnalystImpl(projectId, feedbackId, {
      getFeedback: (p, f) => this.getFeedback(p, f),
      saveFeedback: (p, i) => this.saveFeedback(p, i),
      enqueueForCategorization: (p, f) => this.enqueueForCategorization(p, f),
      categorizationService: this.categorizationService,
      taskCreationService: this.taskCreationService,
    });
  }

  async listFeedback(projectId: string): Promise<FeedbackItem[]>;
  async listFeedback(
    projectId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<FeedbackItem[] | { items: FeedbackItem[]; total: number }>;
  async listFeedback(
    projectId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<FeedbackItem[] | { items: FeedbackItem[]; total: number }> {
    return feedbackStore.listFeedback(projectId, options);
  }

  async submitFeedback(projectId: string, body: FeedbackSubmitRequest): Promise<FeedbackItem> {
    return submitFeedbackImpl(projectId, body, {
      enqueueForCategorization: (p, f) => this.enqueueForCategorization(p, f),
    });
  }

  private async saveFeedback(projectId: string, item: FeedbackItem): Promise<void> {
    await feedbackStore.updateFeedback(projectId, item);
  }

  async retryPendingCategorizations(projectId: string): Promise<number> {
    return retryPendingCategorizations(projectId, {
      listFeedback: (p) => this.listFeedback(p),
      listPendingFeedbackIds: (p) => this.listPendingFeedbackIds(p),
      enqueueForCategorization: (p, f) => this.enqueueForCategorization(p, f),
    });
  }

  async recategorizeFeedback(
    projectId: string,
    feedbackId: string,
    options?: { answer?: string }
  ): Promise<FeedbackItem> {
    return recategorizeFeedbackImpl(projectId, feedbackId, options, {
      getFeedback: (p, f) => this.getFeedback(p, f),
      saveFeedback: (p, i) => this.saveFeedback(p, i),
      enqueueForCategorization: (p, f) => this.enqueueForCategorization(p, f),
    });
  }

  async checkAutoResolveOnTaskDone(projectId: string, closedTaskId: string): Promise<void> {
    return checkAutoResolveOnTaskDoneImpl(projectId, closedTaskId, {
      listFeedback: (p) => this.listFeedback(p),
      getFeedback: (p, f) => this.getFeedback(p, f),
      saveFeedback: (p, i) => this.saveFeedback(p, i),
    });
  }

  async resolveFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    return resolveFeedbackImpl(projectId, feedbackId, {
      listFeedback: (p) => this.listFeedback(p),
      getFeedback: (p, f) => this.getFeedback(p, f),
      saveFeedback: (p, i) => this.saveFeedback(p, i),
    });
  }

  async cancelFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    return cancelFeedbackImpl(projectId, feedbackId, {
      getFeedback: (p, f) => this.getFeedback(p, f),
    });
  }

  async getFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    return feedbackStore.getFeedback(projectId, feedbackId);
  }
}
