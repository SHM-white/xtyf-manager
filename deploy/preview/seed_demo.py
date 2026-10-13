"""仅初始化全新预览数据库里的虚拟人员与任务；绝不读取生产数据。"""
import os
import secrets
import sqlite3

from werkzeug.security import generate_password_hash

from app import init_db
from common import DB_PATH, now_str


def seed_demo():
    if not os.environ.get("PREVIEW_PR_NUMBER"):
        raise RuntimeError("拒绝在非 PR 预览环境运行示例数据初始化")
    # app 导入已调用 init_db；再次调用依旧幂等。
    init_db()
    db = sqlite3.connect(DB_PATH)
    try:
        db.execute("PRAGMA foreign_keys=ON")
        # 只在第一次打开空库时创建示例，避免每次推送 PR 覆盖手工测试。
        if db.execute("SELECT 1 FROM tasks LIMIT 1").fetchone():
            return
        now = now_str()
        users = (
            ("模拟视觉成员", "demo_vision", "视觉"),
            ("模拟电控成员", "demo_control", "电控"),
        )
        for name, username, group in users:
            db.execute(
                "INSERT OR IGNORE INTO members(name,username,password_hash,group_name,role,created_at) "
                "VALUES(?,?,?,?,?,?)",
                (name, username, generate_password_hash(secrets.token_urlsafe(22)), group, "member", now),
            )
            db.execute("INSERT OR IGNORE INTO groups(name) VALUES(?)", (group,))
            db.execute(
                "INSERT OR IGNORE INTO member_groups(member_id,group_id) "
                "SELECT m.id,g.id FROM members m JOIN groups g ON g.name=? WHERE m.username=?",
                (group, username),
            )
        samples = (
            ("模拟哨兵视觉联调", "demo_vision", "哨兵", "视觉", "进行中", "高"),
            ("模拟步兵电机测试", "demo_control", "步兵", "电控", "未开始", "中"),
            ("模拟哨兵底盘联调", "demo_control", "哨兵", "电控", "进行中", "中"),
        )
        for title, username, project, group, status, priority in samples:
            db.execute("INSERT OR IGNORE INTO projects(name) VALUES(?)", (project,))
            owner_id = db.execute("SELECT id FROM members WHERE username=?", (username,)).fetchone()[0]
            project_id = db.execute("SELECT id FROM projects WHERE name=?", (project,)).fetchone()[0]
            group_id = db.execute("SELECT id FROM groups WHERE name=?", (group,)).fetchone()[0]
            db.execute(
                "INSERT INTO tasks(title,detail,owner_id,group_name,project,project_id,priority,status,"
                "created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (title, "仅用于 PR 预览的虚拟任务", owner_id, group, project, project_id,
                 priority, status, 1, now, now),
            )
            task_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            db.execute("INSERT OR IGNORE INTO task_groups(task_id,group_id) VALUES(?,?)", (task_id, group_id))
            db.execute("INSERT OR IGNORE INTO member_projects(member_id,project_id) VALUES(?,?)", (owner_id, project_id))
        db.commit()
        print("[PR 预览] 已创建虚拟成员和任务", flush=True)
    finally:
        db.close()


if __name__ == "__main__":
    seed_demo()
