-- GiftCred: Woohoo catalog, orders, and OAuth token storage (ported from Python backend)
BEGIN;

-- OAuth tokens for Woohoo API (from backend/schema.sql + models.py)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                  BIGSERIAL PRIMARY KEY,
  access_token        VARCHAR(512) NOT NULL,
  access_token_secret VARCHAR(512) NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_oauth_tokens_is_active ON oauth_tokens (is_active);

-- Gift card product catalog (from backend main.py queries + remote_db_backup structure)
CREATE TABLE IF NOT EXISTS gift_card_products (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          VARCHAR(255) NOT NULL UNIQUE,
  product_category    VARCHAR(128),
  supplier_id         VARCHAR(128),
  display_name        VARCHAR(512),
  face_value_cents    INTEGER,
  cred_price_cents    INTEGER,
  supplier_cost_cents INTEGER,
  supplier_base_url   TEXT,
  margin_percent      NUMERIC(8, 2),
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_gift_card_products_product_id ON gift_card_products (product_id);
CREATE INDEX IF NOT EXISTS ix_gift_card_products_is_active ON gift_card_products (is_active);

-- Placed orders (from backend/models.py Order)
CREATE TABLE IF NOT EXISTS orders (
  id              BIGSERIAL PRIMARY KEY,
  order_id        VARCHAR(64) NOT NULL UNIQUE,
  refno           VARCHAR(64) NOT NULL UNIQUE,
  items           JSONB,
  mobile_number   VARCHAR(32) NOT NULL,
  email           VARCHAR(255),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_orders_order_id ON orders (order_id);
CREATE INDEX IF NOT EXISTS ix_orders_refno ON orders (refno);
CREATE INDEX IF NOT EXISTS ix_orders_created_at ON orders (created_at DESC);

COMMIT;
