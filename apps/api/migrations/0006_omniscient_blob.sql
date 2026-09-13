CREATE TABLE `session_outputs` (
	`file_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`path` text NOT NULL,
	`content_sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_session_outputs_session_path` ON `session_outputs` (`session_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_session_outputs_session` ON `session_outputs` (`session_id`,`updated_at`,`file_id`);