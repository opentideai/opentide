CREATE TABLE "_genie_mcp_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"session_id" text,
	"transport" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"changeset_id" text,
	"arg_bytes" integer NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "_genie_verification_ledger" ADD COLUMN "principal_id" text;--> statement-breakpoint
CREATE INDEX "mcp_calls_created_at_idx" ON "_genie_mcp_calls" USING btree ("created_at");