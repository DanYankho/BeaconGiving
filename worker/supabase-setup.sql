-- ============================================================
--  SUPABASE DATABASE SETUP
--  Run this entire file in your Supabase SQL Editor:
--  Dashboard → SQL Editor → New query → paste → Run
-- ============================================================

-- ── Transactions table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_name       TEXT        NOT NULL,
  donor_email      TEXT,
  donor_phone      TEXT,
  amount           NUMERIC(12,2) NOT NULL,
  currency         TEXT        NOT NULL DEFAULT 'MWK',
  giving_type      TEXT        NOT NULL,
  payment_method   TEXT        NOT NULL,
  transaction_ref  TEXT        NOT NULL UNIQUE,
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','success','failed')),
  project_name     TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at      TIMESTAMPTZ
);

-- Index for fast reference lookups (webhook + verify endpoint)
CREATE INDEX IF NOT EXISTS idx_transactions_ref
  ON transactions (transaction_ref);

-- Index for filtering by giving type and status in future dashboard
CREATE INDEX IF NOT EXISTS idx_transactions_giving_type
  ON transactions (giving_type);

CREATE INDEX IF NOT EXISTS idx_transactions_status
  ON transactions (status);

CREATE INDEX IF NOT EXISTS idx_transactions_created_at
  ON transactions (created_at DESC);

-- ── Error log table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS error_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source     TEXT,
  message    TEXT,
  payload    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Row Level Security ───────────────────────────────────────
-- The Worker uses the SERVICE ROLE KEY which bypasses RLS.
-- These policies only apply to anon/authenticated roles.
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_log    ENABLE ROW LEVEL SECURITY;

-- Deny all access to anonymous users (only service role can read/write)
CREATE POLICY "deny_anon_transactions" ON transactions
  FOR ALL TO anon USING (false);

CREATE POLICY "deny_anon_error_log" ON error_log
  FOR ALL TO anon USING (false);

-- ── Verification query ───────────────────────────────────────
-- Run this after setup to confirm tables were created:
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
