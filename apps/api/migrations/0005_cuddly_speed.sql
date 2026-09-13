ALTER TABLE `sessions` ADD `active_seconds` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `duration_seconds` real DEFAULT 0 NOT NULL;