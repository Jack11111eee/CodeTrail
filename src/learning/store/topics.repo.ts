import type {
  Database,
  GenerationId,
  LearningTopic,
  LearningTopicsRepo,
  ProjectId,
} from "../contracts/index.js";

interface Row {
  topic_id: string;
  generation_id: GenerationId;
  conversation_id: LearningTopic["conversationId"];
  title: string | null;
  auto_title: number;
  first_question: string | null;
  lesson_message_id: LearningTopic["lessonMessageId"];
  state: LearningTopic["state"];
  error_detail: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
const columns =
  "t.topic_id,t.generation_id,t.conversation_id,t.title,t.auto_title,t.first_question,t.lesson_message_id,t.state,t.error_detail,t.created_at,t.updated_at,t.deleted_at";
const select = `SELECT ${columns} FROM learning_topics t`;
function record(row: Row): LearningTopic {
  return {
    topicId: row.topic_id,
    generationId: row.generation_id,
    conversationId: row.conversation_id,
    title: row.title,
    autoTitle: row.auto_title === 1,
    firstQuestion: row.first_question,
    lessonMessageId: row.lesson_message_id,
    state: row.state,
    error: row.error_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function createTopicsRepo(db: Database): LearningTopicsRepo {
  return {
    insert(t): void {
      db.raw
        .prepare(
          "INSERT INTO learning_topics(topic_id,generation_id,conversation_id,title,auto_title,first_question,lesson_message_id,state,error_detail,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          t.topicId,
          t.generationId,
          t.conversationId,
          t.title,
          t.autoTitle ? 1 : 0,
          t.firstQuestion,
          t.lessonMessageId,
          t.state,
          t.error,
          t.createdAt,
          t.updatedAt,
          t.deletedAt,
        );
    },
    byId(id, opts): LearningTopic | null {
      const row = db.raw
        .prepare(
          `${select} WHERE t.topic_id = ?${opts?.includeDeleted ? "" : " AND t.deleted_at IS NULL"}`,
        )
        .get(id) as Row | undefined;
      return row ? record(row) : null;
    },
    listByGeneration(id: GenerationId, opts): LearningTopic[] {
      return (
        db.raw
          .prepare(
            `${select} WHERE t.generation_id = ?${opts?.includeDeleted ? "" : " AND t.deleted_at IS NULL"} ORDER BY t.created_at,t.topic_id`,
          )
          .all(id) as Row[]
      ).map(record);
    },
    listByProject(id: ProjectId, opts): LearningTopic[] {
      return (
        db.raw
          .prepare(
            `${select} JOIN generations g ON g.generation_id = t.generation_id WHERE g.project_id = ?${opts?.includeDeleted ? "" : " AND t.deleted_at IS NULL"} ORDER BY t.created_at,t.topic_id`,
          )
          .all(id) as Row[]
      ).map(record);
    },
    begin(id, question, at): boolean {
      return (
        Number(
          db.raw
            .prepare(
              "UPDATE learning_topics SET state='generating',error_detail=NULL,first_question=CASE WHEN lesson_message_id IS NULL THEN ? ELSE first_question END,updated_at=? WHERE topic_id=? AND state<>'generating' AND deleted_at IS NULL",
            )
            .run(question, at, id).changes,
        ) > 0
      );
    },
    finish(id, patch): void {
      db.raw
        .prepare(
          `UPDATE learning_topics SET state=?,error_detail=?,updated_at=?${patch.title === undefined ? "" : ",title=?"}${patch.lessonMessageId === undefined ? "" : ",lesson_message_id=?"} WHERE topic_id=? AND deleted_at IS NULL`,
        )
        .run(
          patch.state,
          patch.error,
          patch.updatedAt,
          ...(patch.title === undefined ? [] : [patch.title]),
          ...(patch.lessonMessageId === undefined
            ? []
            : [patch.lessonMessageId]),
          id,
        );
    },
    setDeleted(id, at): void {
      db.raw
        .prepare("UPDATE learning_topics SET deleted_at=? WHERE topic_id=?")
        .run(at, id);
    },
    recoverInterrupted(at): void {
      db.raw
        .prepare(
          "UPDATE learning_topics SET state=CASE WHEN lesson_message_id IS NULL THEN 'failed' ELSE 'ready' END,error_detail='服务已重启，生成中断；问题和已有讲解已保存，可重试',updated_at=? WHERE state='generating'",
        )
        .run(at);
    },
  };
}
