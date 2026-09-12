CREATE TABLE `session_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`type` text DEFAULT 'file' NOT NULL,
	`file_id` text NOT NULL,
	`mount_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_session_resources_session` ON `session_resources` (`session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_session_resources_file_id` ON `session_resources` (`file_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_session_resources_mount_path` ON `session_resources` (`session_id`,`mount_path`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`agent_version` integer NOT NULL,
	`agent_config` text NOT NULL,
	`environment_id` text NOT NULL,
	`environment_snapshot` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`title` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_input_tokens` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_created_at_id` ON `sessions` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_agent_version` ON `sessions` (`agent_id`,`agent_version`,`created_at`,`id`);