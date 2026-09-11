CREATE TABLE `skill_files` (
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	`path` text NOT NULL,
	`content` blob NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	PRIMARY KEY(`skill_id`, `version`, `path`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`directory` text NOT NULL,
	`file_count` integer NOT NULL,
	`total_bytes` integer NOT NULL,
	`content_sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`skill_id`, `version`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_skill_versions_id` ON `skill_versions` (`id`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`display_title` text,
	`source` text DEFAULT 'custom' NOT NULL,
	`latest_version_seq` integer,
	`next_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_skills_created_at_id` ON `skills` (`created_at`,`id`);