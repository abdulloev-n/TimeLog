-- TimeLog migration 002: issued invoices are immutable.
-- Run inside one transaction after 001. The runner records version 2.
-- Importing a backup replaces the whole database file, so these triggers do not block restores.

CREATE TRIGGER invoices_no_update
BEFORE UPDATE ON invoices
BEGIN
  SELECT RAISE(ABORT, 'Issued invoices cannot be edited.');
END;

CREATE TRIGGER invoices_no_delete
BEFORE DELETE ON invoices
BEGIN
  SELECT RAISE(ABORT, 'Issued invoices cannot be deleted.');
END;
