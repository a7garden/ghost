//! Recall provenance supplies candidate addresses only. Every candidate still
//! needs the independent exact scoped episode-resource inspection.
use super::*;

fn episode_hint(reference: &str) -> Option<&str> {
    let id = reference.strip_prefix("episode://").unwrap_or(reference);
    valid_episode_id(id).then_some(id)
}

pub(super) fn candidate_ids(envelope: &Value) -> Result<Vec<String>> {
    let layers = envelope["data"]["layers"]
        .as_array()
        .ok_or_else(|| anyhow!("OxiBrain source provenance response is malformed"))?;
    let mut ids = std::collections::BTreeSet::new();
    for layer in layers {
        if let Some(provenance) = layer.get("provenance").and_then(Value::as_array) {
            for reference in provenance.iter().filter_map(Value::as_str) {
                if let Some(id) = episode_hint(reference) {
                    ids.insert(id.to_owned());
                    if ids.len() >= 64 {
                        return Ok(ids.into_iter().collect());
                    }
                }
            }
        }
    }
    Ok(ids.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_recovery_native_episode_uri_and_legacy_id_are_only_address_hints() {
        let id = "a".repeat(64);
        assert_eq!(episode_hint(&format!("episode://{id}")), Some(id.as_str()));
        assert_eq!(episode_hint(&id), Some(id.as_str()));
        for reference in [
            format!("episode://{id}?space=foreign"),
            format!("episode://{id}#fragment"),
            format!("episode://%61{}", &id[1..]),
            format!("episode:///{id}"),
            format!("episode://{id}/"),
            format!("EPISODE://{id}"),
            format!("session://{id}"),
            format!("document://{id}"),
            format!("https://foreign/{id}"),
            format!("episode://{}", id.to_uppercase()),
            "episode://".into(),
        ] {
            assert_eq!(episode_hint(&reference), None, "{reference}");
        }
    }

    #[test]
    fn source_recovery_collects_native_shapes_deduplicates_and_retains_original_cap() {
        let first = "0".repeat(64);
        let mut provenance = vec![
            json!(format!("episode://{first}")),
            json!(first),
            json!(null),
            json!({"id":"untrusted"}),
        ];
        for n in 1..70 {
            provenance.push(json!(format!("episode://{n:064x}")));
        }
        let envelope = json!({"data":{"layers":[{"provenance":["document://foreign","session://other"]},{"provenance":provenance}]}});
        let ids = candidate_ids(&envelope).unwrap();
        assert_eq!(ids.len(), 64);
        assert_eq!(ids[0], first);
        assert_eq!(ids[63], format!("{:064x}", 63));
        assert!(ids.iter().all(|id| valid_episode_id(id)));
    }

    #[test]
    fn source_recovery_malformed_or_unrelated_evidence_cannot_supply_an_episode() {
        for envelope in [
            json!({}),
            json!({"data":{"layers":null}}),
            json!({"data":{"layers":{}}}),
        ] {
            assert!(candidate_ids(&envelope).is_err());
        }
        let envelope = json!({"data":{"layers":[{"text":"episode://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
            {"provenance":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
            {"provenance":["episode://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?space=foreign","not-an-id"]}]}});
        assert!(candidate_ids(&envelope).unwrap().is_empty());
    }
}
