PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`narrator_id` text,
	`agent_label` text,
	`message_id` text,
	`orchestration_run_id` text,
	`kind` text DEFAULT 'narrator' NOT NULL,
	`role` text,
	`provider` text,
	`credential_id` text,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer,
	`context_window` integer,
	`input_token_semantics` text,
	`usage_source` text,
	`context_source` text,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_5m_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_1h_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`ttft_ms` integer,
	`duration_ms` integer,
	`cost_usd` real,
	`cost_status` text,
	`cost_missing_fields` text,
	`context_percent` real,
	`meter_usage` real,
	`meter_unit` text,
	`error_message` text,
	`raw_dump_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_api_requests_observation_tokens" CHECK(
			("__new_api_requests"."prompt_tokens" IS NULL OR (typeof("__new_api_requests"."prompt_tokens") = 'integer' AND "__new_api_requests"."prompt_tokens" >= 0 AND "__new_api_requests"."prompt_tokens" <= 2000000000))
			AND ("__new_api_requests"."context_window" IS NULL OR (typeof("__new_api_requests"."context_window") = 'integer' AND "__new_api_requests"."context_window" >= 0 AND "__new_api_requests"."context_window" <= 2000000000))
		)
);
--> statement-breakpoint
INSERT INTO `__new_api_requests`("id", "user_id", "narrator_id", "agent_label", "message_id", "orchestration_run_id", "kind", "role", "provider", "credential_id", "model", "input_tokens", "prompt_tokens", "context_window", "input_token_semantics", "usage_source", "context_source", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "cache_creation_5m_tokens", "cache_creation_1h_tokens", "reasoning_tokens", "ttft_ms", "duration_ms", "cost_usd", "cost_status", "cost_missing_fields", "context_percent", "meter_usage", "meter_unit", "error_message", "raw_dump_json", "created_at") SELECT "id", "user_id", "narrator_id", "agent_label", "message_id", "orchestration_run_id", "kind", "role", "provider", "credential_id", "model", "input_tokens", "prompt_tokens", "context_window", "input_token_semantics", "usage_source", "context_source", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "cache_creation_5m_tokens", "cache_creation_1h_tokens", "reasoning_tokens", "ttft_ms", "duration_ms", "cost_usd", "cost_status", "cost_missing_fields", "context_percent", "meter_usage", "meter_unit", "error_message", "raw_dump_json", "created_at" FROM `api_requests`;--> statement-breakpoint
DROP TABLE `api_requests`;--> statement-breakpoint
ALTER TABLE `__new_api_requests` RENAME TO `api_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_api_requests_narrator` ON `api_requests` (`narrator_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_message` ON `api_requests` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_provider` ON `api_requests` (`provider`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_kind` ON `api_requests` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_orchestration_run_created` ON `api_requests` (`orchestration_run_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_created` ON `api_requests` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_user_created` ON `api_requests` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_credential` ON `api_requests` (`credential_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `background_tasks` ADD `orchestration_run_id` text;--> statement-breakpoint
CREATE INDEX `idx_bg_tasks_orchestration_run` ON `background_tasks` (`orchestration_run_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `__new_orchestration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`coordinator_narrator_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`tier` text NOT NULL,
	`worker_narrator_id` text,
	`model` text,
	`phase` text NOT NULL,
	`current_phase` text DEFAULT 'unknown' NOT NULL,
	`last_progress_seq` integer,
	`last_progress_at` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`reused_worker` integer DEFAULT false NOT NULL,
	`verdict` text,
	`error` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	CONSTRAINT "ck_orchestration_runs_progress_seq" CHECK(("__new_orchestration_runs"."last_progress_seq" IS NULL OR (typeof("__new_orchestration_runs"."last_progress_seq") = 'integer' AND "__new_orchestration_runs"."last_progress_seq" >= 0 AND "__new_orchestration_runs"."last_progress_seq" <= 2000000000)))
);
--> statement-breakpoint
INSERT INTO `__new_orchestration_runs`("id", "coordinator_narrator_id", "profile_id", "tier", "worker_narrator_id", "model", "phase", "current_phase", "last_progress_seq", "last_progress_at", "attempt", "reused_worker", "verdict", "error", "started_at", "finished_at", "duration_ms") SELECT "id", "coordinator_narrator_id", "profile_id", "tier", "worker_narrator_id", "model", "phase", "current_phase", "last_progress_seq", "last_progress_at", "attempt", "reused_worker", "verdict", "error", "started_at", "finished_at", "duration_ms" FROM `orchestration_runs`;--> statement-breakpoint
DROP TABLE `orchestration_runs`;--> statement-breakpoint
ALTER TABLE `__new_orchestration_runs` RENAME TO `orchestration_runs`;--> statement-breakpoint
CREATE INDEX `idx_orchestration_runs_coordinator_started` ON `orchestration_runs` (`coordinator_narrator_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_runs_worker` ON `orchestration_runs` (`worker_narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_runs_started` ON `orchestration_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_runs_progress` ON `orchestration_runs` (`current_phase`,`last_progress_at`);