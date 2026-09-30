-- Library-owned organizational sets. Entries, source lineage and adoptions stay canonical.
CREATE TABLE library_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('collection', 'group')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  client_mutation_id text CHECK (length(client_mutation_id) BETWEEN 1 AND 128),
  client_mutation_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (library_id, kind, created_by_user_id, client_mutation_id)
);
CREATE INDEX library_selections_list_idx ON library_selections (library_id, kind, created_at DESC, id DESC) WHERE status = 'active';
CREATE TABLE library_selection_members (
  selection_id uuid NOT NULL REFERENCES library_selections(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES library_entries(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0 AND position < 200),
  PRIMARY KEY (selection_id, entry_id),
  UNIQUE (selection_id, position)
);
CREATE INDEX library_selection_members_entry_idx ON library_selection_members (entry_id);
