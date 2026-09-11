/**
 * Deployment 与运行记录类型。见 references/deployments.md 与
 * references/api/{create,get,run}-deployment*.md。
 */
import type { ListQuery, Metadata } from "./common";
import type { InitialUserMessageEventInput, SessionAgentInput, SessionResource } from "./session";

export type DeploymentStatus = "active" | "paused";

export interface CronScheduleInput {
  type: "cron";
  /** 五段 cron 表达式;当前仅支持 Asia/Shanghai 时区 */
  expression: string;
  timezone?: "Asia/Shanghai" | null;
}

export interface CronScheduleResponse {
  type: "cron";
  expression: string;
  timezone: "Asia/Shanghai";
  last_run_at: string | null;
  upcoming_runs_at: string[];
}

export interface DeploymentAgent {
  type: "agent";
  id: string;
  version: number;
}

export type DeploymentPausedReason =
  | { type: "manual" }
  | {
      type: "error";
      error: {
        type:
          | "environment_archived_error"
          | "environment_not_found_error"
          | "file_not_found_error"
          | "memory_store_archived_error"
          | "vault_archived_error"
          | "vault_not_found_error";
      };
    };

export interface Deployment {
  id: string;
  type: "deployment";
  name: string;
  agent: DeploymentAgent;
  environment_id: string;
  description: string | null;
  metadata: Metadata;
  resources: SessionResource[];
  /** null 表示仅手动运行 */
  schedule: CronScheduleResponse | null;
  initial_events: InitialUserMessageEventInput[];
  status: DeploymentStatus;
  paused_reason: DeploymentPausedReason | null;
  vault_ids: string[];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentCreateInput {
  name: string;
  agent: SessionAgentInput;
  environment_id: string;
  schedule?: CronScheduleInput | null;
  /** 每次运行时注入的 1–50 条 user.message */
  initial_events: InitialUserMessageEventInput[];
  description?: string | null;
  metadata?: Metadata;
  vault_ids?: string[];
  resources?: SessionResource[];
}

export interface DeploymentRun {
  id: string;
  type: "deployment_run";
  deployment_id: string;
  trigger_context: {
    type: "schedule" | "manual";
    /** 仅定时触发的 Run 返回 */
    scheduled_at?: string;
  };
  session_id: string | null;
  /** Run 是否成功通过 error 是否为 null 判断 */
  error: { type: string; message: string } | null;
  agent: DeploymentAgent;
  created_at: string;
}

export interface DeploymentRunListQuery extends ListQuery {
  deployment_id?: string;
  has_error?: boolean;
  trigger_type?: "schedule" | "manual";
  "created_at[gt]"?: string;
  "created_at[gte]"?: string;
  "created_at[lt]"?: string;
  "created_at[lte]"?: string;
}
