-- PostgreSQL schema for Woohoo Catalog Sync Service

CREATE TABLE IF NOT EXISTS oauth_tokens (
    id              SERIAL PRIMARY KEY,
    access_token    VARCHAR(512) NOT NULL,
    access_token_secret VARCHAR(512) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_oauth_tokens_is_active ON oauth_tokens (is_active);

CREATE TABLE IF NOT EXISTS categories (
    id                  SERIAL PRIMARY KEY,
    woohoo_category_id  VARCHAR(64) NOT NULL UNIQUE,
    name                VARCHAR(512) NOT NULL,
    raw_response        JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_categories_woohoo_category_id ON categories (woohoo_category_id);

CREATE TABLE IF NOT EXISTS subcategories (
    id                      SERIAL PRIMARY KEY,
    woohoo_subcategory_id   VARCHAR(64) NOT NULL UNIQUE,
    category_id             INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    parent_subcategory_id   INTEGER REFERENCES subcategories(id) ON DELETE CASCADE,
    name                    VARCHAR(512) NOT NULL,
    raw_response            JSONB,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_subcategories_category_id ON subcategories (category_id);
CREATE INDEX IF NOT EXISTS ix_subcategories_parent_subcategory_id ON subcategories (parent_subcategory_id);
CREATE INDEX IF NOT EXISTS ix_subcategories_woohoo_subcategory_id ON subcategories (woohoo_subcategory_id);
