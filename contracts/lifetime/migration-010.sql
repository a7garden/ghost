-- Coordinator-owned additive responsibility graph. No legacy identity is rewritten.
CREATE TABLE IF NOT EXISTS lifetime_graph_budgets (
 root_goal_id TEXT PRIMARY KEY REFERENCES lifetime_goals(id),
 deadline_ms INTEGER NOT NULL CHECK(deadline_ms > 0),
 automatic_revisions INTEGER NOT NULL DEFAULT 0 CHECK(automatic_revisions BETWEEN 0 AND 2),
 expired INTEGER NOT NULL DEFAULT 0 CHECK(expired IN (0,1)));
CREATE TABLE IF NOT EXISTS lifetime_work_links (
 child_work_id TEXT PRIMARY KEY REFERENCES lifetime_work(id),
 parent_work_id TEXT NOT NULL REFERENCES lifetime_work(id),
 parent_goal_revision INTEGER NOT NULL CHECK(parent_goal_revision > 0),
 root_goal_id TEXT NOT NULL REFERENCES lifetime_graph_budgets(root_goal_id),
 depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 3),
 current INTEGER NOT NULL DEFAULT 1 CHECK(current IN (0,1)),
 CHECK(child_work_id <> parent_work_id));
CREATE INDEX IF NOT EXISTS lifetime_work_children ON lifetime_work_links(parent_work_id,current);
CREATE INDEX IF NOT EXISTS lifetime_work_graph_root ON lifetime_work_links(root_goal_id,current);
CREATE TABLE IF NOT EXISTS lifetime_blocking_edges (
 waiter_work_id TEXT NOT NULL REFERENCES lifetime_work(id),
 blocker_work_id TEXT NOT NULL REFERENCES lifetime_work(id),
 kind TEXT NOT NULL CHECK(kind IN ('dependency','resource_hold')),
 PRIMARY KEY(waiter_work_id,blocker_work_id,kind),
 CHECK(waiter_work_id <> blocker_work_id));
CREATE TABLE IF NOT EXISTS lifetime_graph_wakes (
 parent_work_id TEXT NOT NULL REFERENCES lifetime_work(id),
 child_work_id TEXT NOT NULL REFERENCES lifetime_work(id),
 child_goal_revision INTEGER NOT NULL CHECK(child_goal_revision > 0),
 state TEXT NOT NULL CHECK(state IN ('completed','failed','cancelled','accepted')),
 PRIMARY KEY(parent_work_id,child_work_id,child_goal_revision,state));
