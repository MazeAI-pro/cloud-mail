-- Explicit additive migration; preserve every previous operation and retired address.
CREATE TABLE IF NOT EXISTS managed_address_lifetime (
  external_key TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE
);
-- Even identities renamed more than once before this policy have consumed their allowance.
INSERT OR IGNORE INTO managed_address_lifetime(external_key, operation_id)
  SELECT external_key, operation_id FROM managed_address_change ORDER BY created_at, operation_id;
CREATE TRIGGER IF NOT EXISTS managed_address_lifetime_claim BEFORE INSERT ON managed_address_change
BEGIN
  INSERT INTO managed_address_lifetime(external_key, operation_id) VALUES (NEW.external_key, NEW.operation_id);
END;
CREATE TRIGGER IF NOT EXISTS managed_address_lifetime_no_delete BEFORE DELETE ON managed_address_lifetime
BEGIN SELECT RAISE(ABORT, 'lifetime_claim_permanent');
END;
CREATE TRIGGER IF NOT EXISTS managed_address_lifetime_no_update BEFORE UPDATE ON managed_address_lifetime
BEGIN SELECT RAISE(ABORT, 'lifetime_claim_permanent');
END;
