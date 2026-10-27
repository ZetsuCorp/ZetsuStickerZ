
-- Store each native SOL quote separately from legacy AWT purchase amounts.
ALTER TABLE public.capsule_purchases
  ADD COLUMN IF NOT EXISTS sol_amount numeric(20, 9);

-- New SOL purchases do not provide an AWT amount.
ALTER TABLE public.capsule_purchases
  ALTER COLUMN awt_amount DROP NOT NULL;
