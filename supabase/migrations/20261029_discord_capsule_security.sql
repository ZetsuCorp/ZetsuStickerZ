-- One Discord entitlement must never grant two stickers.
CREATE UNIQUE INDEX IF NOT EXISTS capsule_purchases_payment_reference_unique
ON public.capsule_purchases(payment_reference);
-- Only privileged, payment-verifying Edge Functions may invoke the reward grant.
REVOKE ALL ON FUNCTION public.complete_capsule_purchase(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_capsule_purchase(uuid,text) TO service_role;
