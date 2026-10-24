CREATE TABLE "_genie_document_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"version_hash" text,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"role" text NOT NULL,
	"session_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "_genie_document_versions" (
	"version_hash" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"size" integer NOT NULL,
	"mime" text NOT NULL,
	"storage_path" text NOT NULL,
	"created_by" text NOT NULL,
	"note" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "_genie_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text DEFAULT 'local_legacy' NOT NULL,
	"project_id" text,
	"session_id" text,
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"current_version_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "document_refs_document_id_idx" ON "_genie_document_refs" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_refs_ref_idx" ON "_genie_document_refs" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "document_versions_document_id_idx" ON "_genie_document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_scope_idx" ON "_genie_documents" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "documents_session_id_idx" ON "_genie_documents" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "documents_project_id_idx" ON "_genie_documents" USING btree ("project_id");