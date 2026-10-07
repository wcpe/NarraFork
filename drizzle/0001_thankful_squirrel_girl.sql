CREATE TABLE `orchestration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`coordinator_narrator_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`tier` text NOT NULL,
	`worker_narrator_id` text,
	`model` text,
	`phase` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`reused_worker` integer DEFAULT false NOT NULL,
	`verdict` text,
	`error` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE INDEX `idx_orchestration_runs_coordinator_started` ON `orchestration_runs` (`coordinator_narrator_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_runs_worker` ON `orchestration_runs` (`worker_narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_runs_started` ON `orchestration_runs` (`started_at`);