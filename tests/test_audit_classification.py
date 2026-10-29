"""Audit grouping, retention and upgrade behavior (synthetic data only)."""
import sqlite3
import unittest
from contextlib import closing
from unittest.mock import patch

from modules.audit_retention import classify_action, cleanup_plan, migrate_classification


def fake_db():
    db = sqlite3.connect(':memory:')
    db.executescript("""
        CREATE TABLE security_audit (
            id INTEGER PRIMARY KEY, action TEXT NOT NULL, outcome TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
        );
        CREATE TABLE invoice_jobs (audit_id INTEGER);
    """)
    return db


class AuditClassificationTests(unittest.TestCase):
    def test_categories_and_severity(self):
        cases = {
            ('funds.delete_record', 'success'): ('finance', 'permanent'),
            ('funds.delete_record', 'failure'): ('finance', 'permanent'),
            ('invoices.api_upload', 'success'): ('finance', 'permanent'),
            ('invoices.job.refresh', 'error'): ('finance', 'permanent'),
            ('security.permissions_set', 'success'): ('security', 'critical'),
            ('client_api.login', 'failure'): ('security', 'critical'),
            ('assets.operate', 'success'): ('assets', 'important'),
            ('task_catalogs.member_create', 'success'): ('members', 'important'),
            ('task_catalogs.groups_delete', 'success'): ('tasks', 'important'),
            ('task_catalogs.projects_edit', 'success'): ('tasks', 'normal'),
            ('workspace_settings.workspace_countdown', 'success'): ('settings', 'routine'),
            ('member_profiles.account_preferences', 'failure'): ('settings', 'critical'),
            ('unknown_endpoint', 'success'): ('other', 'critical'),
        }
        for (action, outcome), expected in cases.items():
            with self.subTest(action=action, outcome=outcome):
                self.assertEqual(classify_action(action, outcome), expected)

    def test_migration_backfills_once_preserving_finance(self):
        with closing(fake_db()) as db:
            db.executemany(
                'INSERT INTO security_audit(id,action,outcome,created_at) VALUES(?,?,?,?)',
                [(1, 'funds.delete_record', 'success', '2000-01-01'),
                 (2, 'invoices.job.organize', 'failure', '2000-01-01'),
                 (3, 'member_profiles.account_preferences', 'success', '2000-01-01'),
                 (4, 'some_future_feature', 'success', '2000-01-01')])
            migrate_classification(db)
            first = db.execute('SELECT category,level FROM security_audit ORDER BY id').fetchall()
            self.assertEqual(first, [('finance', 'permanent'), ('finance', 'permanent'),
                                     ('settings', 'routine'), ('other', 'critical')])
            migrate_classification(db)
            self.assertEqual(db.execute('SELECT category,level FROM security_audit ORDER BY id').fetchall(), first)

    def test_permanent_finance_survives_expiry_and_cap_even_if_legacy_level(self):
        with closing(fake_db()) as db:
            db.executemany(
                'INSERT INTO security_audit(id,action,outcome,created_at) VALUES(?,?,?,?)',
                [(1, 'funds.create_record', 'success', '2000-01-01'),
                 (2, 'invoices.api_export_download', 'success', '2000-01-01'),
                 (3, 'workspace_settings.workspace_countdown', 'success', '2000-01-01'),
                 (4, 'task_catalogs.projects_edit', 'success', '2000-01-01')])
            migrate_classification(db)
            # Simulate old writer assigning "critical" to a financial event.
            db.execute("UPDATE security_audit SET level='critical' WHERE id=2")
            with patch.dict('os.environ', {'AUDIT_RETENTION_DAYS':'1',
                      'AUDIT_IMPORTANT_RETENTION_DAYS':'1', 'AUDIT_NORMAL_RETENTION_DAYS':'1',
                      'AUDIT_ROUTINE_RETENTION_DAYS':'1', 'AUDIT_MAX_ROWS':'1'}):
                plan = cleanup_plan(db)
            self.assertEqual(plan['ids'], [3, 4])
            self.assertNotIn(1, plan['ids'])
            self.assertNotIn(2, plan['ids'])

    def test_pending_invoice_job_and_request_chain_survive(self):
        with closing(fake_db()) as db:
            db.executemany(
                'INSERT INTO security_audit(id,action,outcome,details,created_at) VALUES(?,?,?,?,?)',
                [(1, 'task_catalogs.projects_edit', 'success', '{}', '2000-01-01'),
                 (2, 'invoices.job.organize', 'success', '{"request_audit_id":1}', '2000-01-01'),
                 (3, 'task_catalogs.projects_edit', 'pending', '{}', '2000-01-01')])
            db.execute('INSERT INTO invoice_jobs(audit_id) VALUES(2)')
            migrate_classification(db)
            with patch.dict('os.environ', {'AUDIT_NORMAL_RETENTION_DAYS':'1',
                                            'AUDIT_MAX_ROWS':'1'}):
                plan = cleanup_plan(db)
            self.assertEqual(plan['ids'], [])


if __name__ == '__main__':
    unittest.main()
