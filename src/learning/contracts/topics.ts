import type {
  ConversationId,
  GenerationId,
  MessageId,
  ProjectId,
} from "./ids.js";
import type { MessageView } from "./api.js";

export interface LearningTopic {
  topicId: string;
  generationId: GenerationId;
  conversationId: ConversationId;
  /** Null until the first successful answer names an untitled topic. */
  title: string | null;
  autoTitle: boolean;
  firstQuestion: string | null;
  lessonMessageId: MessageId | null;
  state: "draft" | "generating" | "ready" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LearningTopicView extends LearningTopic {
  displayTitle: string;
  lesson: MessageView | null;
}

export interface LearningTopicsRepo {
  insert(topic: LearningTopic): void;
  byId(id: string, opts?: { includeDeleted?: boolean }): LearningTopic | null;
  listByGeneration(
    id: GenerationId,
    opts?: { includeDeleted?: boolean },
  ): LearningTopic[];
  listByProject(
    id: ProjectId,
    opts?: { includeDeleted?: boolean },
  ): LearningTopic[];
  /** Atomic per-topic writer claim, including follow-up turns. */
  begin(id: string, question: string, at: string): boolean;
  finish(
    id: string,
    patch: Pick<LearningTopic, "state" | "error" | "updatedAt"> &
      Partial<Pick<LearningTopic, "title" | "lessonMessageId">>,
  ): void;
  setDeleted(id: string, at: string | null): void;
  recoverInterrupted(at: string): void;
}
