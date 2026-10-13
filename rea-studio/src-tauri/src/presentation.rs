use crate::models::Inspection;
use serde_json::Value;
fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}
/// Owns the projection of retained REA facts into the Studio inspector contract.
/// Unknown selected-fact metadata is never replaced by record-wide certainty.
pub fn inspect(header: &Value, facts: &Value, limitations: &Value) -> Inspection {
    let observation = facts["observations"]
        .as_array()
        .and_then(|items| items.first());
    let metadata = observation
        .map(|o| &o["evidence"])
        .unwrap_or(&facts["evidence"]);
    let record = facts.is_null();
    Inspection {
        label: observation
            .and_then(|o| text(&o["label"]))
            .or_else(|| text(&facts["relation"])),
        kind: text(&facts["kind"]).or_else(|| {
            if facts["relation"].is_string() {
                Some("relationship".into())
            } else {
                None
            }
        }),
        evidence_id: text(&header["evidence_id"]),
        operation: text(&header["operation"]),
        provider: text(&header["provider"]["name"]),
        state: text(if record {
            &header["confidence"]
        } else {
            &metadata["state"]
        }),
        authority: text(if record {
            &header["authority"]
        } else {
            &metadata["authority"]
        }),
        coverage: text(&metadata["coverage"]["status"]),
        location: metadata["location"].clone(),
        properties: observation
            .map(|o| o["properties"].clone())
            .unwrap_or_else(|| facts["properties"].clone()),
        limitations: if record {
            limitations.clone()
        } else {
            metadata["limitations"].clone()
        },
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn selected_fact_unknowns_do_not_inherit_record_certainty() {
        let header = json!({"evidence_id":"original-id","confidence":"observed","authority":"shipped-artifact","operation":"analyze_javascript_application","provider":{"name":"actual provider"}});
        let facts = json!({"kind":"unknown","observations":[{"label":"unresolved import","properties":{},"evidence":{"state":"unknown","authority":"unknown","location":{"available":false,"reason":"unresolved"},"coverage":{"status":"unknown"},"limitations":["Unresolved import"]}}]});
        let view = inspect(&header, &facts, &json!([]));
        assert_eq!(view.state.as_deref(), Some("unknown"));
        assert_eq!(view.authority.as_deref(), Some("unknown"));
        assert_eq!(view.location["available"], false);
    }
}
