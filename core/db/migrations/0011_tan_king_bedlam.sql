CREATE TABLE "_genie_verification_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"changeset_id" text NOT NULL,
	"changeset_title" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"fingerprint" text NOT NULL,
	"scope" text NOT NULL,
	"check_id" text,
	"summary" text NOT NULL,
	"tool_call_id" text,
	"turn_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "verification_ledger_scope_idx" ON "_genie_verification_ledger" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "verification_ledger_kind_idx" ON "_genie_verification_ledger" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "verification_ledger_created_at_idx" ON "_genie_verification_ledger" USING btree ("created_at");