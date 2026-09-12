CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`config` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_environments_created_at_id` ON `environments` (`created_at`,`id`);