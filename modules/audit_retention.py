"""Stable audit classification and explicit, backup-first retention maintenance."""
import os
from datetime import datetime, timedelta

ROUTINE_ACTIONS = ('member_profiles.account_preferences',)
LEVELS = ('permanent', 'critical', 'important', 'normal', 'routine')
CATEGORIES = ('finance', 'security', 'assets', 'members', 'tasks', 'collaboration', 'settings', 'other')


def classify_action(action, outcome='pending'):
    """Return (business category, retention priority). Unknown actions fail closed."""
    action = str(action or '')
    outcome = str(outcome or 'pending')
    # Financial records (including rejected operations, exports and async jobs)
    # must never become subject to age- or capacity-based deletion.
    if action.startswith(('funds.', 'invoices.', 'invoice_jobs.', 'funds_')):
        return 'finance', 'permanent'
    if (action in {'login', 'logout', 'api_password', 'export_members_csv',
                   'api_member_reset', 'api_member_role', 'api_member_toggle'}
            or action.startswith(('security.', 'client_api.login', 'client_api.logout'))):
        return 'security', 'critical'
    if action in ROUTINE_ACTIONS:
        category, level = 'settings', 'routine'
    elif action.startswith(('assets.', 'asset_', 'asset_bom.')):
        category, level = 'assets', 'important'
    elif (action.startswith(('member_profiles.', 'members.', 'member.', 'api_member',
                              'task_catalogs.member_', 'task_catalogs.members_'))):
        category, level = 'members', 'important'
    elif (action.startswith(('task_', 'tasks.', 'task.', 'task_catalogs.', 'projects.',
                              'daily_projects.', 'task_schedule.'))):
        category, level = 'tasks', 'normal'
    elif action.startswith(('collaboration.', 'discussions.', 'github_', 'mail_', 'notifications.')):
        category, level = 'collaboration', 'normal'
    elif action.startswith(('workspace_settings.', 'client_updates.', 'pwa.')):
        category, level = 'settings', 'routine'
    else:
        category, level = 'other', 'critical'
    if outcome in ('failure', 'partial'):
        level = 'critical'
    elif any(part in action.lower() for part in ('delete', 'restore', 'rollback', 'revoke', 'export')):
        if level in ('normal', 'routine'):
            level = 'important'
    return category, level


def migrate_classification(db):
    """Reclassify existing rows once when category is introduced; never delete here."""
    columns = {r[1] for r in db.execute('PRAGMA table_info(security_audit)')}
    needs_backfill = 'category' not in columns or 'level' not in columns
    if 'level' not in columns:
        db.execute("ALTER TABLE security_audit ADD COLUMN level TEXT NOT NULL DEFAULT 'critical'")
    if 'category' not in columns:
        db.execute("ALTER TABLE security_audit ADD COLUMN category TEXT NOT NULL DEFAULT 'other'")
    if needs_backfill:
        rows = db.execute('SELECT id,action,outcome FROM security_audit').fetchall()
        db.executemany(
            'UPDATE security_audit SET category=?,level=? WHERE id=?',
            ((*classify_action(action, outcome), identifier) for identifier, action, outcome in rows),
        )


def cleanup_plan(db):
    """Preview expired rows. Finance is protected even if a legacy level is wrong."""
    days = {
        'critical': max(0, int(os.environ.get('AUDIT_RETENTION_DAYS', '365'))),
        'important': max(0, int(os.environ.get('AUDIT_IMPORTANT_RETENTION_DAYS', '180'))),
        'normal': max(0, int(os.environ.get('AUDIT_NORMAL_RETENTION_DAYS', '90'))),
        'routine': max(0, int(os.environ.get('AUDIT_ROUTINE_RETENTION_DAYS', '7'))),
    }
    protected = {r[0] for r in db.execute("""WITH RECURSIVE protected(id) AS (
        SELECT id FROM security_audit WHERE outcome='pending'
        UNION SELECT audit_id FROM invoice_jobs
        UNION SELECT CAST(json_extract(a.details,'$.request_audit_id') AS INTEGER)
        FROM security_audit a JOIN protected p ON p.id=a.id
        WHERE json_valid(a.details) AND json_type(a.details,'$.request_audit_id')='integer'
    ) SELECT id FROM protected""")}
    has_action = 'action' in {r[1] for r in db.execute('PRAGMA table_info(security_audit)')}
    rows = db.execute(
        'SELECT id,level,created_at' + (',action' if has_action else '') +
        ' FROM security_audit ORDER BY id'
    ).fetchall()
    # Never delete financial events even if they still carry the old 'critical'
    # classification, or a reset/older writer assigned that value.
    finance_ids = {r[0] for r in rows if r[1] == 'permanent' or
                   (has_action and classify_action(r[3])[0] == 'finance')}
    protected |= finance_ids
    cutoffs = {level: (datetime.now() - timedelta(days=n)).strftime('%Y-%m-%d %H:%M:%S')
               for level, n in days.items() if n}
    ids = {r[0] for r in rows if r[0] not in protected and
           r[1] in cutoffs and r[2] < cutoffs[r[1]]}
    limit = max(0, int(os.environ.get('AUDIT_MAX_ROWS', '100000')))
    if limit:
        excess = max(0, len(rows) - len(ids) - limit)
        # Capacity pressure only discards routine events; never important evidence.
        for r in rows:
            if excess <= 0:
                break
            if r[0] not in protected | ids and r[1] == 'routine':
                ids.add(r[0])
                excess -= 1
    return {
        'counts': {level: sum(r[1] == level for r in rows) for level in LEVELS},
        'delete_counts': {level: sum(r[1] == level and r[0] in ids for r in rows)
                          for level in LEVELS},
        'ids': sorted(ids), 'protected': len(protected),
        'retention_days': {'permanent': None, **days},
    }


def cleanup_audit_rows(db, *, confirmed=False):
    plan = cleanup_plan(db)
    if confirmed:
        db.executemany('DELETE FROM security_audit WHERE id=?', ((i,) for i in plan['ids']))
    return plan
