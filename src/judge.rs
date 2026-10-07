//! LocalJudge: advisory-only recommendation of an allowed candidate.
//! It has no authority-granting API. The deterministic mock picks the first
//! candidate that is in the allowed set; empty candidates yield None.
//! Laya candidate notes and any weighting are coordinator backlog.

use serde::Serialize;

#[derive(Debug, Clone)]
pub struct JudgeInput {
    pub prompt: String,
    pub candidates: Vec<String>,
    pub allowed: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct Recommendation {
    pub candidate_id: String,
    pub rationale: String,
}

pub trait LocalJudge: Send + Sync {
    fn name(&self) -> &'static str;
    fn recommend(&self, input: &JudgeInput) -> Option<Recommendation>;
}

pub struct MockJudge;

impl LocalJudge for MockJudge {
    fn name(&self) -> &'static str {
        "mock"
    }
    fn recommend(&self, input: &JudgeInput) -> Option<Recommendation> {
        input
            .candidates
            .iter()
            .find(|c| input.allowed.contains(c))
            .map(|c| Recommendation {
                candidate_id: c.clone(),
                rationale: format!(
                    "mock judge: first candidate present in the allowed set, for prompt {:?}",
                    input.prompt
                ),
            })
    }
}
