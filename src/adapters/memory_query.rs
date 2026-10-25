//! Temporal read intent is explicit; documents have revision reads, not
//! bitemporal memory semantics. Never turn an unsupported past query into now.
use super::*;

const SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Default)]
pub(super) struct QueryScope {
    as_of: Option<i64>,
    known_at: Option<i64>,
    planes: Option<Vec<String>>,
}
pub(super) struct QueryError {
    code: &'static str,
    plane: Option<&'static str>,
    fields: Vec<&'static str>,
}
impl QueryError {
    fn invalid() -> Self {
        Self {
            code: "invalid_temporal_scope",
            plane: None,
            fields: vec![],
        }
    }
    pub(super) fn output(self) -> ToolOutput {
        let mut output = ToolOutput::error(
            ToolStatus::Denied,
            if self.code == "unsupported_temporal_scope" && self.plane == Some("memory") {
                "The native engine does not advertise temporal memory query support. No current-time fallback was queried."
            } else if self.code == "unsupported_temporal_scope" {
                "Requested temporal scope is unsupported; document revisions are distinct from memory as_of/known_at. No current-time fallback was queried."
            } else {
                "Temporal scope requires safe integer epoch-millisecond timestamps, known_at no later than this request, and unique memory/documents planes. No query was sent."
            },
        );
        output.content = json!({"error_code":self.code,"plane":self.plane,"fields":self.fields});
        output
    }
}
impl QueryScope {
    pub(super) fn parse(args: &Value) -> std::result::Result<Self, QueryError> {
        let timestamp = |key| {
            args.get(key)
                .map(|value| {
                    value
                        .as_i64()
                        .filter(|v| (-SAFE_INTEGER..=SAFE_INTEGER).contains(v))
                        .ok_or_else(QueryError::invalid)
                })
                .transpose()
        };
        let mut scope = Self {
            as_of: timestamp("as_of")?,
            known_at: timestamp("known_at")?,
            planes: None,
        };
        if scope.known_at.is_some_and(|known| {
            known
                > SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|time| time.as_millis().min(i64::MAX as u128) as i64)
                    .unwrap_or(0)
        }) {
            return Err(QueryError::invalid());
        }
        if let Some(value) = args.get("planes") {
            let values = value
                .as_array()
                .filter(|values| !values.is_empty() && values.len() <= 2)
                .ok_or_else(QueryError::invalid)?;
            let mut planes = Vec::new();
            for value in values {
                let plane = value
                    .as_str()
                    .filter(|v| ["memory", "documents"].contains(v))
                    .ok_or_else(QueryError::invalid)?;
                if planes.iter().any(|v| v == plane) {
                    return Err(QueryError::invalid());
                }
                planes.push(plane.to_owned());
            }
            scope.planes = Some(planes);
        }
        if scope.temporal() {
            if scope
                .planes
                .as_ref()
                .is_some_and(|planes| planes.iter().any(|v| v == "documents"))
            {
                return Err(scope.unsupported("documents"));
            }
            if scope.planes.is_none() {
                scope.planes = Some(vec!["memory".into()]);
            }
        }
        Ok(scope)
    }
    fn unsupported(&self, plane: &'static str) -> QueryError {
        QueryError {
            code: "unsupported_temporal_scope",
            plane: Some(plane),
            fields: [("as_of", self.as_of), ("known_at", self.known_at)]
                .into_iter()
                .filter_map(|(name, value)| value.map(|_| name))
                .collect(),
        }
    }
    pub(super) fn temporal(&self) -> bool {
        self.as_of.is_some() || self.known_at.is_some()
    }
    pub(super) fn apply(&self, args: &mut Value) {
        if let Some(value) = self.as_of {
            args["as_of"] = json!(value);
        }
        if let Some(value) = self.known_at {
            args["known_at"] = json!(value);
        }
        if let Some(planes) = &self.planes {
            args["planes"] = json!(planes);
        }
    }
    pub(super) fn metadata(&self) -> Value {
        let mut value = json!({});
        self.apply(&mut value);
        value
    }
    pub(super) async fn validate_native(
        &self,
        client: &mut BrainClient,
        tool: &str,
    ) -> Result<Option<ToolOutput>> {
        if !self.temporal() {
            return Ok(None);
        }
        let tools = client.call_rpc_json("tools/list", json!({})).await?;
        let properties =
            listed_input_schema(&tools, tool).and_then(|schema| schema.get("properties"));
        if !properties.is_some_and(|p| {
            ["as_of", "known_at", "planes"]
                .iter()
                .all(|key| p.get(key).is_some())
        }) {
            return Ok(Some(self.unsupported("memory").output()));
        }
        Ok(None)
    }
}

pub(crate) fn error_code(output: &ToolOutput) -> Option<&'static str> {
    match output.content["error_code"].as_str() {
        Some("unsupported_temporal_scope") => Some("unsupported_temporal_scope"),
        Some("invalid_temporal_scope") => Some("invalid_temporal_scope"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporal_scope_is_explicit_bounded_and_never_falls_back_to_current_documents() {
        let scope = QueryScope::parse(&json!({"as_of":0,"known_at":-1}))
            .unwrap_or_else(|_| panic!("valid temporal scope"));
        assert_eq!(
            scope.metadata(),
            json!({"as_of":0,"known_at":-1,"planes":["memory"]})
        );
        for value in [
            json!(null),
            json!("2026-01-01"),
            json!(1.2),
            json!(9_007_199_254_740_992_i64),
        ] {
            assert_eq!(
                QueryScope::parse(&json!({"as_of":value}))
                    .err()
                    .unwrap()
                    .output()
                    .content["error_code"],
                "invalid_temporal_scope"
            );
        }
        assert!(QueryScope::parse(&json!({"known_at":SAFE_INTEGER})).is_err());
        for planes in [json!(["documents"]), json!(["memory", "documents"])] {
            let error = QueryScope::parse(&json!({"known_at":0,"planes":planes}))
                .err()
                .unwrap()
                .output();
            assert_eq!(
                error.content,
                json!({"error_code":"unsupported_temporal_scope","plane":"documents","fields":["known_at"]})
            );
        }
        for planes in [json!([]), json!(["memory", "memory"]), json!(["other"])] {
            assert!(QueryScope::parse(&json!({"planes":planes})).is_err());
        }
        assert_eq!(
            QueryScope::parse(&json!({}))
                .unwrap_or_else(|_| panic!("current query"))
                .metadata(),
            json!({})
        );
    }
}
