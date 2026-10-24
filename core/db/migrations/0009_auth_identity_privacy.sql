ALTER TABLE "_genie_sessions" ADD COLUMN "owner_user_id" text DEFAULT 'local_legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE "_genie_sessions" ADD COLUMN "visibility" text DEFAULT 'project' NOT NULL;
--> statement-breakpoint
ALTER TABLE "_genie_sessions" ALTER COLUMN "visibility" SET DEFAULT 'private';
--> statement-breakpoint
ALTER TABLE "_genie_messages" ADD COLUMN "author_user_id" text;
--> statement-breakpoint
ALTER TABLE "_genie_changelog" ADD COLUMN "actor_user_id" text;
--> statement-breakpoint
ALTER TABLE "_genie_changesets" ADD COLUMN "creator_user_id" text;
