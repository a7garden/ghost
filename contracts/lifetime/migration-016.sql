-- Only known no-effect browser approvals may resume an original effect.
ALTER TABLE lifetime_pi_executions ADD COLUMN paused_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lifetime_pi_effects RENAME TO lifetime_pi_effects_v15;
CREATE TABLE lifetime_pi_effects (
 execution_id TEXT NOT NULL REFERENCES lifetime_pi_executions(execution_id),
 task_id INTEGER NOT NULL CHECK(task_id > 0), call_id TEXT NOT NULL,
 input_digest TEXT NOT NULL, operation TEXT NOT NULL, arguments_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('waiting_owner','pending','complete','unknown')),
 response_json TEXT, wait_started_ms INTEGER,
 PRIMARY KEY(execution_id,task_id,call_id)
);
INSERT INTO lifetime_pi_effects(execution_id,task_id,call_id,input_digest,operation,arguments_json,state,response_json)
 SELECT execution_id,task_id,call_id,input_digest,operation,arguments_json,state,response_json FROM lifetime_pi_effects_v15;
DROP TABLE lifetime_pi_effects_v15;
