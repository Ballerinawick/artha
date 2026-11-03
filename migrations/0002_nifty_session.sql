CREATE TABLE IF NOT EXISTS nifty_session (
  day text PRIMARY KEY,
  expiry text NOT NULL,
  legs jsonb NOT NULL,
  book jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
