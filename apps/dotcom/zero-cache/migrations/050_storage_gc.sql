-- Ledger tables for the scheduled storage GC in sync-worker (see storageGc.ts).
--
-- Deleting a board or a workspace only sets "isDeleted", and nothing ever hard-deleted the
-- row afterwards, so every R2 object behind a deleted board outlived it forever: the room
-- snapshot, its edit history, published snapshots, thumbnails and uploaded assets. The
-- cleanup itself already exists (TLFileDurableObject.appFileRecordDidDelete), but it only
-- runs off a DELETE FROM file, which until now only an admin could cause.
--
-- "deleted_entity" records when a row entered the trash, so the GC can apply a grace period
-- rather than inferring one from "updatedAt" (which room persists bump every few seconds).
-- "asset_unreferenced" records when a board stopped referencing an upload, so an image
-- deleted from a board stops costing storage without breaking undo.
--
-- Both are server-only: NOT added to the zero_data publication.

CREATE TABLE public.deleted_entity (
	"tableName" VARCHAR NOT NULL, -- 'file' | 'group'
	"entityId"  VARCHAR NOT NULL,
	"deletedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY ("tableName", "entityId")
);

CREATE INDEX deleted_entity_due_idx ON public.deleted_entity ("tableName", "deletedAt");

-- Restoring a row (undeleteFile, or the workspace equivalent) clears its ledger entry, so a
-- restored board can never be purged by a pass that started before the restore.
CREATE OR REPLACE FUNCTION file_trash_ledger_fn() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		DELETE FROM public.deleted_entity WHERE "tableName" = 'file' AND "entityId" = OLD.id;
		RETURN OLD;
	END IF;
	IF TG_OP = 'INSERT' AND NOT NEW."isDeleted" THEN
		RETURN NEW;
	END IF;
	IF NEW."isDeleted" THEN
		INSERT INTO public.deleted_entity ("tableName", "entityId")
		VALUES ('file', NEW.id)
		ON CONFLICT ("tableName", "entityId") DO NOTHING;
	ELSE
		DELETE FROM public.deleted_entity WHERE "tableName" = 'file' AND "entityId" = NEW.id;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER file_trash_ledger
AFTER INSERT OR DELETE OR UPDATE OF "isDeleted" ON public."file"
FOR EACH ROW EXECUTE FUNCTION file_trash_ledger_fn();

CREATE OR REPLACE FUNCTION group_trash_ledger_fn() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		DELETE FROM public.deleted_entity WHERE "tableName" = 'group' AND "entityId" = OLD.id;
		RETURN OLD;
	END IF;
	IF TG_OP = 'INSERT' AND NOT NEW."isDeleted" THEN
		RETURN NEW;
	END IF;
	IF NEW."isDeleted" THEN
		INSERT INTO public.deleted_entity ("tableName", "entityId")
		VALUES ('group', NEW.id)
		ON CONFLICT ("tableName", "entityId") DO NOTHING;
	ELSE
		DELETE FROM public.deleted_entity WHERE "tableName" = 'group' AND "entityId" = NEW.id;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER group_trash_ledger
AFTER INSERT OR DELETE OR UPDATE OF "isDeleted" ON public."group"
FOR EACH ROW EXECUTE FUNCTION group_trash_ledger_fn();

-- Backfill dates the existing backlog from now, not from when each row was really deleted:
-- "updatedAt" is bumped by room persists, so it is not a delete timestamp, and a wrong guess
-- here purges boards on the first pass with no undo. The backlog therefore ages out one
-- retention period after this deploys; to reclaim it sooner, run the admin GC route with an
-- explicit retention of 0 days.
INSERT INTO public.deleted_entity ("tableName", "entityId")
SELECT 'file', "id" FROM public."file" WHERE "isDeleted" = true
ON CONFLICT ("tableName", "entityId") DO NOTHING;

INSERT INTO public.deleted_entity ("tableName", "entityId")
SELECT 'group', "id" FROM public."group" WHERE "isDeleted" = true
ON CONFLICT ("tableName", "entityId") DO NOTHING;

-- An upload a board no longer references. Written by the room DO when a persist changes which
-- objects the document points at; the delay between that and the GC deleting the object is
-- what keeps undo working after an image is deleted from a board.
CREATE TABLE public.asset_unreferenced (
	"objectName" VARCHAR PRIMARY KEY REFERENCES public."asset" ("objectName") ON DELETE CASCADE,
	"fileId"     VARCHAR NOT NULL,
	"since"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX asset_unreferenced_since_idx ON public.asset_unreferenced ("since");

-- Both the association pass and the GC read assets by owning file; the FK column had no index.
CREATE INDEX IF NOT EXISTS "asset_fileId_idx" ON public."asset" ("fileId");
