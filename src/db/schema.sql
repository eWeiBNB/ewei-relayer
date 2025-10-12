-- eWei Relayer Database Schema
-- Run with: psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Transactions ────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_key_id    UUID NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  priority      INTEGER NOT NULL DEFAULT 1,

  -- Original request
  sender        VARCHAR(42) NOT NULL,
  target        VARCHAR(42) NOT NULL,
  calldata      TEXT NOT NULL,
  value         VARCHAR(78) NOT NULL DEFAULT '0',
  gas_limit     VARCHAR(78) NOT NULL,
  deadline      BIGINT NOT NULL,
  forwarder_nonce VARCHAR(78) NOT NULL,
  signature     TEXT NOT NULL,
  policy_id     VARCHAR(66) NOT NULL,

  -- Submission details
  tx_hash       VARCHAR(66),
  relayer_nonce  INTEGER,
  gas_price     VARCHAR(78),
  block_number  BIGINT,
  gas_used      VARCHAR(78),

  -- Tracking
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  webhook_url   TEXT,
  webhook_sent  BOOLEAN DEFAULT FALSE,

  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  submitted_at  TIMESTAMP WITH TIME ZONE,
  confirmed_at  TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_api_key ON transactions(api_key_id);
CREATE INDEX idx_transactions_sender ON transactions(sender);
CREATE INDEX idx_transactions_tx_hash ON transactions(tx_hash);
CREATE INDEX idx_transactions_created ON transactions(created_at);

-- ── API Keys ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key_hash        VARCHAR(128) NOT NULL UNIQUE,
  key_prefix      VARCHAR(12) NOT NULL,
  name            VARCHAR(255) NOT NULL,
  sponsor_address VARCHAR(42) NOT NULL,
  rate_limit      INTEGER NOT NULL DEFAULT 100,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_used_at    TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_sponsor ON api_keys(sponsor_address);

-- ── Policies (cached from on-chain) ────────────────
CREATE TABLE IF NOT EXISTS policies (
  id                VARCHAR(66) PRIMARY KEY,
  sponsor           VARCHAR(42) NOT NULL,
  max_gas_per_tx    VARCHAR(78) NOT NULL,
  max_total_gas     VARCHAR(78) NOT NULL,
  used_gas          VARCHAR(78) NOT NULL DEFAULT '0',
  allowed_contracts TEXT[] DEFAULT '{}',
  allowed_methods   TEXT[] DEFAULT '{}',
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at        BIGINT NOT NULL,
  synced_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── Webhooks ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhooks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_key_id  UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      VARCHAR(128) NOT NULL,
  events      TEXT[] NOT NULL DEFAULT '{tx.confirmed}',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_webhooks_api_key ON webhooks(api_key_id);

-- ── Metrics / Daily Stats ──────────────────────────
CREATE TABLE IF NOT EXISTS daily_stats (
  date            DATE PRIMARY KEY,
  total_txs       INTEGER NOT NULL DEFAULT 0,
  successful_txs  INTEGER NOT NULL DEFAULT 0,
  failed_txs      INTEGER NOT NULL DEFAULT 0,
  total_gas_used  VARCHAR(78) NOT NULL DEFAULT '0',
  total_gas_cost  VARCHAR(78) NOT NULL DEFAULT '0',
  unique_senders  INTEGER NOT NULL DEFAULT 0
);

-- ── Update trigger ─────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_transactions_updated
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
