//! Explicit read-only JSON self-inspection. Values, verifier programs and
//! expected answers never enter this observation. Parsing uses the complete
//! existing bounded UTF-8 snapshot, before the legacy line-selection view.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) const KIND: &str = "ghost-json-summary/1";
const MAX_SUMMARY_BYTES: usize = 1536;
const MAX_NODES: usize = 4096;
const MAX_DEPTH: usize = 16;
const MAX_ENTRIES: usize = 8;
const MAX_KEY_BYTES: usize = 48;
const MAX_PATH_BYTES: usize = 96;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Contract {
    source: &'static str,
    schema: Option<Value>,
    candidate_digest: Option<String>,
    cases: BTreeMap<String, String>,
}
impl Contract {
    fn unavailable(source: &'static str) -> Self {
        Self { source, schema: None, candidate_digest: None, cases: BTreeMap::new() }
    }
}

pub(super) fn requested(operation: &str, args: &Value) -> bool {
    operation == "read" && args["view"] == "json_summary"
}
pub(super) fn arguments(args: &Value) -> Result<()> {
    if args.get("view").is_some() {
        apply::exact_fields(args, &["path", "view"])?;
        ensure!(matches!(args["view"].as_str(), Some("json_summary" | "text_snapshot")), "read view is unsupported");
        Ok(())
    } else {
        apply::allowed_fields(args, &["path", "offset", "limit"], &["path"])
    }
}

/// Resolve only the exact current Work's original Owner source or verified
/// evaluation origin. An active template/definition pointer is never a source.
pub(super) fn contract(conn: &Connection, work: &Work, path: &str) -> Result<Contract> {
    if let Some((_input, template)) = super::super::task_contracts::work_source(conn, work)? {
        if path != template.content.artifact_path {
            return Ok(Contract::unavailable("path_not_declared_output"));
        }
        return Ok(Contract {source:"owner_task_output", schema:Some(template.content.output_schema),
            candidate_digest:None, cases:BTreeMap::new()});
    }
    if let Some(descriptor) = super::super::evaluation_inputs::work_input_descriptor(conn, work)? {
        // input_snapshot reuses full original evaluation admission validation
        // with current epoch/cancellation/graph checks, not just progress IDs.
        let (_, bytes) = super::super::evaluation_inputs::input_snapshot(conn, work)?
            .ok_or_else(|| anyhow!("verified evaluation input unavailable"))?;
        if descriptor["artifact_path"].as_str() != Some(path) {
            return Ok(Contract::unavailable("path_not_declared_output"));
        }
        let candidate = crate::host::bots_provisioning::candidate(conn,
            descriptor["candidate_id"].as_str().ok_or_else(||anyhow!("evaluation candidate missing"))?)?;
        ensure!(descriptor["candidate_digest"] == candidate.digest, "evaluation candidate changed");
        let input:Value = serde_json::from_slice(&bytes)?;
        let mut cases=BTreeMap::new();
        for case in input["cases"].as_array().ok_or_else(||anyhow!("evaluation identities missing"))? {
            let id=case["fixture_id"].as_str().ok_or_else(||anyhow!("evaluation case identity missing"))?;
            let digest=case["input_digest"].as_str().ok_or_else(||anyhow!("evaluation input digest missing"))?;
            ensure!(cases.insert(id.into(),digest.into()).is_none(),"evaluation identities ambiguous");
        }
        ensure!((2..=8).contains(&cases.len()),"evaluation identities exceed bound");
        return Ok(Contract {source:"bot_evaluation_output",schema:candidate.source_contract
            .as_ref().map(|pin|pin.producer.output_schema.clone()),candidate_digest:Some(candidate.digest),cases});
    }
    Ok(Contract::unavailable("no_pinned_output_schema"))
}

fn kind(value:&Value)->&'static str {match value {Value::Null=>"null",Value::Bool(_)=>"boolean",Value::Number(_)=>"number",Value::String(_)=>"string",Value::Array(_)=>"array",Value::Object(_)=>"object"}}
fn bounded_text(value:&str,max:usize)->(String,bool) {
    if value.len()<=max {return (value.into(),false)}
    let mut end=max;while !value.is_char_boundary(end) {end-=1;}
    (value[..end].into(),true)
}
struct Shape {entries:Vec<Value>,nodes:usize,depth:usize,truncated:bool}
impl Shape {
    fn visit(&mut self,value:&Value,path:String,path_truncated:bool,depth:usize) {
        if self.nodes>=MAX_NODES || depth>MAX_DEPTH {self.truncated=true;return}
        self.nodes+=1;self.depth=self.depth.max(depth);
        if self.entries.len()<MAX_ENTRIES {
            let (path,cut)=bounded_text(&path,MAX_PATH_BYTES);
            self.truncated |= path_truncated||cut;
            let mut entry=json!({"path":path,"type":kind(value),"path_truncated":path_truncated||cut});
            if let Some(items)=value.as_array() {entry["item_count"]=json!(items.len());}
            if let Some(keys)=value.as_object() {entry["property_count"]=json!(keys.len());}
            self.entries.push(entry);
        } else {self.truncated=true;}
        match value {
            Value::Array(items)=>for (i,item) in items.iter().enumerate() {
                if self.nodes>=MAX_NODES {self.truncated=true;break}
                self.visit(item,format!("{path}/{i}"),path_truncated,depth+1);
            },
            Value::Object(map)=>for (key,item) in map {
                if self.nodes>=MAX_NODES {self.truncated=true;break}
                let (key,cut)=bounded_text(key,MAX_KEY_BYTES);
                let escaped=key.replace('~',"~0").replace('/',"~1");
                self.visit(item,format!("{path}/{escaped}"),path_truncated||cut,depth+1);
            },
            _=>{}
        }
    }
}
fn schema_valid(schema:&Value,value:&Value)->Result<bool> {
    // Preserve root $ref/$defs/$id semantics: compile the original schema at
    // its root, including separately for each evaluation case's output.
    super::super::task_contracts::bounded_schema(schema,0)?;
    ensure!(serde_json::to_vec(schema)?.len()<=16384,"pinned schema exceeds bound");
    Ok(jsonschema::validator_for(schema)?.is_valid(value))
}
fn check_contract(contract:&Contract,value:&Value)->Result<Value> {
    if let Some(digest)=&contract.candidate_digest {
        let envelope=json!({"type":"object","additionalProperties":false,"required":["candidate_digest","cases"],
            "properties":{"candidate_digest":{"const":digest},"cases":{"type":"array","minItems":contract.cases.len(),"maxItems":contract.cases.len(),"items":{
                "type":"object","additionalProperties":false,"required":["id","input_digest","output"],"properties":{"id":{"type":"string"},"input_digest":{"type":"string"},"output":true}}}}});
        let envelope_valid=schema_valid(&envelope,value)?;
        let mut ids=BTreeSet::new();let mut identities_valid;let mut outputs_valid=true;
        let cases=value["cases"].as_array();
        if let Some(cases)=cases {
            identities_valid=cases.len()==contract.cases.len();
            if cases.len()>8 {outputs_valid=false;}
            for case in cases.iter().take(8) {
                let id=case["id"].as_str();
                identities_valid &= id.is_some_and(|id|ids.insert(id.to_owned()) && contract.cases.get(id).is_some_and(|digest|case["input_digest"].as_str()==Some(digest.as_str())));
                if let Some(schema)=&contract.schema {outputs_valid &= schema_valid(schema,&case["output"])?;}
            }
        } else {identities_valid=false;}
        identities_valid &= value["candidate_digest"].as_str()==Some(digest.as_str());
        return Ok(json!({"status":if !(envelope_valid&&identities_valid&&outputs_valid) {"invalid"}else if contract.schema.is_some() {"valid"}else{"unavailable"},
            "source":contract.source,"envelope_valid":envelope_valid,"identities_valid":identities_valid,
            "case_count":cases.map(Vec::len),"output_schema_status":if cases.is_some_and(|cases|cases.len()>8) {"not_checked_due_case_bound"}else if contract.schema.is_some() {if outputs_valid {"valid"}else{"invalid"}}else{"unavailable"},
            "output_schema_sha256":contract.schema.as_ref().map(canonical_digest).transpose()?,
            "diagnostic_code":if envelope_valid&&identities_valid&&outputs_valid {Value::Null}else{json!("json_contract_mismatch")}}));
    }
    if let Some(schema)=&contract.schema {
        let valid=schema_valid(schema,value)?;
        return Ok(json!({"status":if valid {"valid"}else{"invalid"},"source":contract.source,
            "output_schema_sha256":canonical_digest(schema)?,"diagnostic_code":if valid {Value::Null}else{json!("json_schema_mismatch")}}));
    }
    Ok(json!({"status":"unavailable","source":contract.source}))
}

pub(super) fn summarize(content:&str,digest:&str,contract:&Contract)->Value {
    let mut result=json!({"kind":KIND,"view":"json_summary","full_file_sha256":digest,
        "full_file_bytes":content.len(),"utf8":true,"semantic_correctness":"not_checked",
        "artifact_acceptance":"not_checked","authority":"read_only_self_inspection",
        "limits":{"max_file_bytes":crate::worker::scoped_tools::MAX_TOOL_CONTENT_BYTES,"max_summary_bytes":MAX_SUMMARY_BYTES,
            "shape_max_nodes":MAX_NODES,"shape_max_depth":MAX_DEPTH,"shape_max_entries":MAX_ENTRIES,"key_max_utf8_bytes":MAX_KEY_BYTES,"path_max_utf8_bytes":MAX_PATH_BYTES}});
    if content.len()>crate::worker::scoped_tools::MAX_TOOL_CONTENT_BYTES {
        result["parse"]=json!({"status":"invalid","code":"json_file_too_large","line":null,"column":null});
        result["schema"]=json!({"status":"not_checked"});return result;
    }
    match serde_json::from_str::<Value>(content) {
        Err(error)=>{
            let code=match error.classify() {serde_json::error::Category::Eof=>"json_unexpected_eof",serde_json::error::Category::Syntax=>"json_syntax",serde_json::error::Category::Data=>"json_data",serde_json::error::Category::Io=>"json_io"};
            result["parse"]=json!({"status":"invalid","code":code,"line":error.line(),"column":error.column()});
            result["schema"]=json!({"status":"not_checked"});
        },
        Ok(value)=>{
            result["parse"]=json!({"status":"complete","root_type":kind(&value)});
            let mut shape=Shape {entries:vec![],nodes:0,depth:0,truncated:false};shape.visit(&value,String::new(),false,0);
            result["shape"]=json!({"entries":shape.entries,"visited_nodes":shape.nodes,"max_observed_depth":shape.depth,"truncated":shape.truncated});
            result["schema"]=check_contract(contract,&value).unwrap_or_else(|_|json!({"status":"unavailable","source":contract.source,"diagnostic_code":"json_schema_unavailable"}));
            while serde_json::to_vec(&result).is_ok_and(|bytes|bytes.len()>MAX_SUMMARY_BYTES) {
                result["shape"]["truncated"]=json!(true);
                if result["shape"]["entries"].as_array_mut().and_then(Vec::pop).is_none() {break}
            }
        }
    }
    result
}

pub(super) fn invalid(summary:&Value)->bool {
    summary["kind"]==KIND && (summary["parse"]["status"]=="invalid" || summary["schema"]["status"]=="invalid"
        || summary["schema"]["diagnostic_code"]=="json_schema_unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observe(text:&str)->Value {summarize(text,&format!("{:x}",Sha256::digest(text.as_bytes())),&Contract::unavailable("no_pinned_output_schema"))}
    #[test]
    fn json_summary_parses_entire_raw_file_and_every_json_type_without_values() {
        for (text,root) in [("null","null"),("true","boolean"),("12.5","number"),("\"VALUE_SECRET_SENTINEL\"","string"),("[1,2]","array"),("{\"name\":\"한글 🐈 VALUE_SECRET_SENTINEL\"}\r\n","object")] {
            let result=observe(text);assert_eq!(result["parse"]["status"],"complete");assert_eq!(result["parse"]["root_type"],root);
            assert_eq!(result["full_file_bytes"],text.len());assert_eq!(result["full_file_sha256"],format!("{:x}",Sha256::digest(text.as_bytes())));
            assert!(!result.to_string().contains("VALUE_SECRET_SENTINEL"));assert_eq!(result["semantic_correctness"],"not_checked");
        }
        for text in ["{}\nTRAILING_SECRET_SENTINEL", "{\"secret\":\"MALFORMED_SECRET_SENTINEL", "{}\n{}"] {
            let result=observe(text);assert_eq!(result["parse"]["status"],"invalid");assert!(!result.to_string().contains("SECRET_SENTINEL"));assert!(result["parse"]["line"].is_number());
        }
        let prefix=format!("{{}}{}INVALID_AFTER_LINE_2000", "\n".repeat(2001));assert_eq!(observe(&prefix)["parse"]["status"],"invalid");
    }
    #[test]
    fn json_summary_limits_and_utf8_key_truncation_are_explicit() {
        let large=format!("[{}]",vec!["0";20000].join(","));let result=observe(&large);
        assert_eq!(result["parse"]["status"],"complete");assert_eq!(result["shape"]["truncated"],true);assert!(serde_json::to_vec(&result).unwrap().len()<=MAX_SUMMARY_BYTES);
        let key="한글🐈".repeat(60);let mut object=serde_json::Map::new();object.insert(key,json!("DO_NOT_ECHO_VALUE"));let result=observe(&Value::Object(object).to_string());
        assert!(result["shape"]["entries"][1]["path_truncated"].as_bool().unwrap());assert!(!result.to_string().contains("DO_NOT_ECHO_VALUE"));
        let oversized=format!("\"{}\"","a".repeat(65535));assert_eq!(observe(&oversized)["parse"]["code"],"json_file_too_large");
        let deep=format!("{}0{}","[".repeat(130),"]".repeat(130));assert_eq!(observe(&deep)["parse"]["status"],"invalid");
        let exact=format!("\"{}\"","한".repeat(21844)+"aa");assert_eq!(exact.len(),65536);assert_eq!(observe(&exact)["parse"]["status"],"complete");
    }
    #[test]
    fn json_summary_large_two_case_readback_is_less_than_half_raw_bytes() {
        let document=json!({"batch":"generic-report","cases":[
            {"id":"first","input_digest":"a".repeat(64),"output":{"records":vec![json!({"label":"VALUE_SECRET_SENTINEL".repeat(12),"flag":true,"weight":42});8]}},
            {"id":"second","input_digest":"b".repeat(64),"output":{"records":vec![json!({"label":"OTHER_VALUE_SENTINEL".repeat(12),"flag":false,"weight":17});8]}}
        ]});
        let content=serde_json::to_string_pretty(&document).unwrap();assert!(content.len()>=4132);
        let result=observe(&content);let summary=serde_json::to_vec(&result).unwrap();
        assert_eq!(result["parse"]["status"],"complete");assert!(summary.len()<=1536 && summary.len()*2<content.len());
        assert!(!result.to_string().contains("VALUE_SECRET_SENTINEL") && !result.to_string().contains("OTHER_VALUE_SENTINEL"));
    }
    #[test]
    fn json_summary_uses_original_schema_root_for_each_case_and_no_oracle() {
        let schema=json!({"$defs":{"scalar":{"type":"string","pattern":"^OK$"}},"$ref":"#/$defs/scalar"});
        let contract=Contract {source:"bot_evaluation_output",schema:Some(schema),candidate_digest:Some("a".repeat(64)),cases:BTreeMap::from([("one".into(),"b".repeat(64)),("two".into(),"c".repeat(64))])};
        let mut value=json!({"candidate_digest":"a".repeat(64),"cases":[{"id":"one","input_digest":"b".repeat(64),"output":"OK"},{"id":"two","input_digest":"c".repeat(64),"output":"OK"}]});
        assert_eq!(summarize(&value.to_string(),"d",&contract)["schema"]["status"],"valid");
        let mut unknown=contract.clone();unknown.schema=None;
        let partial=summarize(&value.to_string(),"d",&unknown);assert_eq!(partial["schema"]["status"],"unavailable");assert_eq!(partial["schema"]["envelope_valid"],true);assert_eq!(partial["schema"]["identities_valid"],true);
        value["cases"][0]["output"]=json!("PRIVATE_INSTANCE_SENTINEL");let result=summarize(&value.to_string(),"d",&contract);
        assert_eq!(result["schema"]["status"],"invalid");assert!(!result.to_string().contains("PRIVATE_INSTANCE_SENTINEL"));
        value["cases"][0]["output"]=json!("OK");value["cases"][1]["id"]=json!("one");assert_eq!(summarize(&value.to_string(),"d",&contract)["schema"]["identities_valid"],false);
    }
}
