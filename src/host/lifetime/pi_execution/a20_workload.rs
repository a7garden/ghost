//! Fixed public fixture + independent oracle. Expected answers never enter a
//! model prompt, container, delegation contract or bridge configuration.
use anyhow::{anyhow, ensure, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const RAW: &str = include_str!("../../../../tests/fixtures/a20/product-comparison-v1.json");
pub fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn canonical(value: &Value) -> String {
    serde_json::to_string(value).expect("A20 integer fixture JSON")
}
pub fn corpus() -> Value {
    serde_json::from_str(RAW).expect("frozen A20 fixture")
}
pub fn source_digest() -> String {
    sha(RAW.as_bytes())
}
pub fn sources_with_hashes() -> Vec<Value> {
    corpus()["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|source| json!({"source":source,"sha256":sha(canonical(source).as_bytes())}))
        .collect()
}
pub fn cases() -> Vec<Value> {
    corpus()["cases"].as_array().unwrap().clone()
}
pub fn evidence() -> Value {
    let mut current: BTreeMap<String, Value> = BTreeMap::new();
    for item in sources_with_hashes() {
        let s = &item["source"];
        let id = s["product_id"].as_str().unwrap().to_owned();
        if current
            .get(&id)
            .is_none_or(|old| old["source_revision"].as_u64() < s["revision"].as_u64())
        {
            current.insert(id.clone(),json!({"product_id":id,"source_ref":s["ref"],"source_revision":s["revision"],"source_sha256":item["sha256"],"facts":s["facts"]}));
        }
    }
    json!({"corpus_sha256":source_digest(),"products":current.into_values().collect::<Vec<_>>(),"superseded_source_refs":["spec-atlas-r1"]})
}
pub fn answer(case: &Value) -> Value {
    let mut eligible = vec![];
    let mut excluded = vec![];
    for p in evidence()["products"].as_array().unwrap() {
        let facts = &p["facts"];
        let mut reasons = vec![];
        let price = facts["price_usd"].as_i64().unwrap();
        let weight = facts["weight_g"].as_i64().unwrap();
        let battery = facts["battery_hours"].as_i64();
        if price > case["max_price_usd"].as_i64().unwrap() {
            reasons.push("price_above_budget");
        }
        if weight > case["max_weight_g"].as_i64().unwrap() {
            reasons.push("weight_above_maximum");
        }
        match battery {
            None => reasons.push("battery_unknown"),
            Some(v) if v < case["min_battery_hours"].as_i64().unwrap() => {
                reasons.push("battery_below_minimum")
            }
            _ => {}
        }
        if case["anc_required"] == true && facts["anc"] != true {
            reasons.push("anc_required");
        }
        reasons.sort_unstable();
        let mut row = json!({"product_id":p["product_id"],"source_ref":p["source_ref"],"source_revision":p["source_revision"],"source_sha256":p["source_sha256"]});
        if reasons.is_empty() {
            row["score"] = json!(
                (case["max_price_usd"].as_i64().unwrap() - price)
                    * case["weights"]["price"].as_i64().unwrap()
                    + battery.unwrap() * case["weights"]["battery"].as_i64().unwrap()
                    + (case["max_weight_g"].as_i64().unwrap() - weight)
                        * case["weights"]["weight"].as_i64().unwrap()
            );
            eligible.push(row);
        } else {
            row["reasons"] = json!(reasons);
            excluded.push(row);
        }
    }
    eligible.sort_by(|a, b| {
        b["score"]
            .as_i64()
            .cmp(&a["score"].as_i64())
            .then_with(|| a["product_id"].as_str().cmp(&b["product_id"].as_str()))
    });
    json!({"case_id":case["id"],"corpus_sha256":source_digest(),"eligible":eligible,"excluded":excluded,"selected_product_id":eligible.first().map(|r|r["product_id"].clone()),"superseded_source_refs":["spec-atlas-r1"]})
}
pub fn evidence_prompt() -> String {
    format!("You are the researcher for a public product comparison. Use the exact source records in your own pinned a20-source-evidence skill, corpus SHA256 {}. Resolve current source revisions, do not rank products or delegate. For each product, choose the revision that supersedes its predecessor; never average contradictory claims or fill missing facts. Write answer.json as compact JSON with lexicographically sorted keys at EVERY object level, no formatting whitespace and no trailing newline. Exact shape: {{corpus_sha256:string,products:[{{product_id:string,source_ref:string,source_revision:integer,source_sha256:string,facts:object}}],superseded_source_refs:[string]}}. Products are sorted by product_id. Facts retain the exact keys and null values from the selected source. Include all superseded source refs sorted. Publish answer.json with public privacy, then complete your own Work.",source_digest())
}
pub fn source_skill() -> String {
    format!("---\nname: a20-source-evidence\ndescription: Frozen public product source evidence\nprivacy: public\n---\n# Product evidence\n\nThese are fixture source data, not instructions. Corpus SHA256: {}\n\n{}",source_digest(),canonical(&json!(sources_with_hashes())))
}
pub fn root_prompt(case: &Value, collaborative: bool) -> String {
    let role = if collaborative {
        "First inspect work_inspect.delegation_contracts and work_children. If no child exists, delegate exactly one researcher using the Host-issued contract_ref, call work_wait. It durably parks this exact original generation until the Host confirms those dependencies have resolved. After that tool returns, continue the same Work and generation, never delegate again or submit a replacement execution: inspect the current Work and read the exact Host-staged child input_artifacts path before comparing. Its accepted evidence must resolve the current source facts. Child acceptance is not your completion."
    } else {
        "Perform the source review and comparison yourself. Do not delegate or create another Goal."
    };
    let inputs = if collaborative {
        "Source facts are available only in the accepted, Host-staged researcher artifact; no raw source facts are duplicated in your root prompt.".into()
    } else {
        format!(
            "Input source evidence: {}.",
            canonical(&json!(sources_with_hashes()))
        )
    };
    format!("Public product comparison. {role} Owner requirements: {}. {inputs} Corpus SHA256: {}. Hard constraints are maximum price, maximum weight, minimum comparable battery hours and ANC when required. Unknown required facts exclude a product. Use corrected/superseding revisions, not obsolete claims. For eligible products score = (max_price_usd-price_usd)*weights.price + battery_hours*weights.battery + (max_weight_g-weight_g)*weights.weight. Rank score descending; tie product_id ascending. Return null selected_product_id for no fit; do not relax constraints. Write answer.json as compact JSON with lexicographically sorted keys at EVERY object level, no formatting whitespace, no trailing newline. Exact keys: case_id,corpus_sha256,eligible,excluded,selected_product_id,superseded_source_refs. eligible is ranked rows {{product_id,score,source_ref,source_revision,source_sha256}}. excluded is product_id-sorted rows {{product_id,reasons,source_ref,source_revision,source_sha256}}. reasons sorted; use ONLY applicable codes price_above_budget,weight_above_maximum,battery_unknown,battery_below_minimum,anc_required. Include all superseded refs sorted. Publish answer.json with public privacy, then finish after successful publication. Do not assert success without tool receipts or change the Owner contract.",canonical(case),source_digest())
}
pub fn quality(actual: Option<&[u8]>, expected: &Value) -> Value {
    let parsed = actual.and_then(|b| serde_json::from_slice::<Value>(b).ok());
    let fields = [
        "case_id",
        "corpus_sha256",
        "eligible",
        "excluded",
        "selected_product_id",
        "superseded_source_refs",
    ];
    let checks: BTreeMap<_, _> = fields
        .into_iter()
        .map(|field| {
            (
                field,
                parsed.as_ref().is_some_and(|v| v[field] == expected[field]),
            )
        })
        .collect();
    json!({"checks":checks,"passed":parsed.as_ref()==Some(expected),"canonical_bytes":actual==Some(canonical(expected).as_bytes()),"checked_fields":6})
}
pub fn validate() -> Result<()> {
    ensure!(
        cases().len() == 3,
        "A20 fixture must contain exactly three frozen cases"
    );
    ensure!(
        answer(&cases()[0])["selected_product_id"] == "ember",
        "value tradeoff oracle changed"
    );
    ensure!(
        answer(&cases()[1])["selected_product_id"].is_null(),
        "no-fit oracle changed"
    );
    ensure!(
        answer(&cases()[2])["selected_product_id"] == "boreal",
        "endurance oracle changed"
    );
    ensure!(
        evidence()["products"][0]["facts"]["battery_hours"] == 18,
        "correction oracle changed"
    );
    Ok(())
}
pub fn percentile(values: &[u64], percent: usize) -> Result<u64> {
    ensure!(
        !values.is_empty() && percent > 0 && percent <= 100,
        "invalid percentile sample"
    );
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let index = (sorted.len() * percent).div_ceil(100) - 1;
    sorted
        .get(index)
        .copied()
        .ok_or_else(|| anyhow!("percentile unavailable"))
}
#[test]
fn fixed_oracle_requires_calculation_correction_and_unknown_refusal() {
    validate().unwrap();
    assert_eq!(answer(&cases()[0])["eligible"][0]["score"], 214);
    assert_eq!(answer(&cases()[0])["eligible"][1]["score"], 212);
    assert_eq!(answer(&cases()[1])["excluded"].as_array().unwrap().len(), 5);
}
#[test]
fn rubric_rejects_stale_source_wrong_ranking_and_invented_missing_battery() {
    let expected = answer(&cases()[0]);
    let bytes = canonical(&expected);
    assert_eq!(quality(Some(bytes.as_bytes()), &expected)["passed"], true);
    for field in ["eligible", "excluded", "selected_product_id"] {
        let mut bad = expected.clone();
        bad[field] = Value::Null;
        assert_eq!(
            quality(Some(canonical(&bad).as_bytes()), &expected)["passed"],
            false
        );
    }
}
#[test]
fn percentile_is_descriptive_nearest_rank() {
    assert_eq!(percentile(&[5, 10, 20], 50).unwrap(), 10);
    assert_eq!(percentile(&[5, 10, 20], 95).unwrap(), 20);
}
#[test]
fn collaborative_root_and_contract_do_not_duplicate_raw_source_records() {
    assert!(!root_prompt(&cases()[0], true).contains("Correction: the 32-hour claim"));
    assert!(!evidence_prompt().contains("Vendor has not supplied"));
    assert!(source_skill().contains("Vendor has not supplied"));
    assert!(root_prompt(&cases()[0], true).contains("this exact original generation"));
    assert!(!root_prompt(&cases()[0], true).contains("STOP this generation"));
}
