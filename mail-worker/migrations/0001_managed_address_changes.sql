-- Explicit operator migration. Never executed during worker requests or bootstrap.
CREATE TABLE IF NOT EXISTS managed_retired_address (
  address TEXT PRIMARY KEY COLLATE NOCASE,
  external_key TEXT NOT NULL,
  retired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS managed_address_change (
  operation_id TEXT PRIMARY KEY,
  external_key TEXT NOT NULL,
  expected_address TEXT NOT NULL,
  new_address TEXT NOT NULL,
  finalized INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS managed_address_one_pending ON managed_address_change(external_key) WHERE finalized = 0;
CREATE TRIGGER IF NOT EXISTS retired_account_insert BEFORE INSERT ON account
WHEN EXISTS (SELECT 1 FROM managed_retired_address WHERE address = NEW.email COLLATE NOCASE)
BEGIN SELECT RAISE(ABORT, 'retired_address');
END;
CREATE TRIGGER IF NOT EXISTS retired_account_update BEFORE UPDATE OF email ON account
WHEN EXISTS (SELECT 1 FROM managed_retired_address WHERE address = NEW.email COLLATE NOCASE)
BEGIN SELECT RAISE(ABORT, 'retired_address');
END;
CREATE TRIGGER IF NOT EXISTS retired_user_insert BEFORE INSERT ON user
WHEN EXISTS (SELECT 1 FROM managed_retired_address WHERE address = NEW.email COLLATE NOCASE)
BEGIN SELECT RAISE(ABORT, 'retired_address');
END;
CREATE TRIGGER IF NOT EXISTS retired_user_update BEFORE UPDATE OF email ON user
WHEN EXISTS (SELECT 1 FROM managed_retired_address WHERE address = NEW.email COLLATE NOCASE)
BEGIN SELECT RAISE(ABORT, 'retired_address');
END;
CREATE TRIGGER IF NOT EXISTS managed_address_change_validate BEFORE INSERT ON managed_address_change
BEGIN
  SELECT CASE WHEN NEW.expected_address = NEW.new_address COLLATE NOCASE THEN RAISE(ABORT, 'address_unchanged') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM account WHERE email = NEW.new_address COLLATE NOCASE)
    OR EXISTS (SELECT 1 FROM user WHERE email = NEW.new_address COLLATE NOCASE)
    THEN RAISE(ABORT, 'address_unavailable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM account a JOIN user u ON a.user_id = u.user_id
    WHERE a.external_key = NEW.external_key AND a.email = NEW.expected_address COLLATE NOCASE
      AND u.email = a.email COLLATE NOCASE AND a.status = 0 AND a.is_del = 0 AND u.status = 0 AND u.is_del = 0
  ) THEN RAISE(ABORT, 'address_changed_or_unavailable') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM managed_retired_address WHERE address = NEW.new_address COLLATE NOCASE)
    THEN RAISE(ABORT, 'retired_address') END;
END;
CREATE TRIGGER IF NOT EXISTS managed_address_change_apply AFTER INSERT ON managed_address_change
BEGIN
  UPDATE user SET email = NEW.new_address WHERE user_id = (SELECT user_id FROM account WHERE external_key = NEW.external_key);
  UPDATE account SET email = NEW.new_address,
    name = CASE WHEN name = substr(NEW.expected_address, 1, instr(NEW.expected_address, '@') - 1)
      THEN substr(NEW.new_address, 1, instr(NEW.new_address, '@') - 1) ELSE name END
    WHERE external_key = NEW.external_key;
  INSERT INTO managed_retired_address(address, external_key) VALUES (NEW.expected_address, NEW.external_key);
END;
