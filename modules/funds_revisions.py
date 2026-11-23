"""Add review versions independently of the historical money-table conversion."""


def migrate(conn):
    conn.execute('BEGIN IMMEDIATE')
    try:
        conn.execute('CREATE TABLE IF NOT EXISTS funds_revision_migrations (version INTEGER PRIMARY KEY)')
        if not conn.execute('SELECT 1 FROM funds_revision_migrations WHERE version=1').fetchone():
            columns = {row[1] for row in conn.execute('PRAGMA table_info(records)')}
            if 'version' not in columns:
                conn.execute('ALTER TABLE records ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
            conn.execute('INSERT INTO funds_revision_migrations VALUES(1)')
        if not conn.execute('SELECT 1 FROM funds_revision_migrations WHERE version=2').fetchone():
            conn.execute('ALTER TABLE records ADD COLUMN self_funded INTEGER NOT NULL DEFAULT 0 CHECK(self_funded IN (0,1))')
            conn.execute('ALTER TABLE records ADD COLUMN applicant_id INTEGER')
            conn.execute('ALTER TABLE records ADD COLUMN personal_invoice_key TEXT')
            conn.execute('ALTER TABLE records ADD COLUMN personal_paid_at TEXT')
            conn.execute('CREATE UNIQUE INDEX funds_personal_invoice_key ON records(personal_invoice_key) '
                         'WHERE personal_invoice_key IS NOT NULL')
            conn.execute('INSERT INTO funds_revision_migrations VALUES(2)')
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
