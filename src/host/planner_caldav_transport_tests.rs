use super::fixture::{reply, Scripted};
use super::*;
use crate::control::api::OwnerAction;
use crate::host::planner_sync::{
    fixtures::{configure_fixture, ics, mutation, owner, Synthetic},
    Host, Kind, Verb,
};

fn root() -> String {
    "<D:response><D:href>/calendar/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>".into()
}

async fn broken_acknowledgement_preserves_status(case: &str, code: u16) {
    let root = tempfile::tempdir().unwrap();
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    configure_fixture(&app, "todos", Kind::Todo, vec![]);
    let base = Synthetic::new("fixture:todos");
    base.seed("ack", ics("ack", Kind::Todo, ""));
    app.planner_pull("todos", &base).await.unwrap();
    let version = super::super::resource(&app.lock().unwrap().journal.0, "todos", "ack")
        .unwrap()
        .unwrap()
        .version;
    let intent = mutation(
        "todos",
        Some("ack"),
        Some(version),
        Verb::Patch,
        serde_json::json!({"title":"desired after failed acknowledgement"}),
    );
    let command = serde_json::to_value(crate::control::api::Action {
        request_id: uuid::Uuid::new_v4().to_string(),
        command: crate::control::api::Command::Workspace {
            action: OwnerAction::PlannerMutation { mutation: intent },
        },
    })
    .unwrap();
    let original_admission = app
        .action(serde_json::from_value(command.clone()).unwrap())
        .unwrap();
    let id = original_admission["result"]["operation_id"]
        .as_str()
        .unwrap();
    let op: super::super::Operation =
        super::super::load(&app.lock().unwrap().journal.0, "planner_operations", id)
            .unwrap()
            .unwrap();
    let desired = op.desired_raw.unwrap();
    let (first, delay) = match case {
        "truncated" => (
            format!(
                "HTTP/1.1 {code} Fixture\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort"
            ),
            Duration::ZERO,
        ),
        "oversize" => (
            format!(
                "HTTP/1.1 {code} Fixture\r\nContent-Length: 65537\r\nConnection: close\r\n\r\n"
            ),
            Duration::ZERO,
        ),
        "delayed" => (reply(code, "", "late body"), Duration::from_secs(1)),
        _ => panic!("unexpected acknowledgement case"),
    };
    // Requery sees desired despite the conditional write's explicit 412.
    let s = Scripted::start_body_delayed(vec![
        (first, delay),
        (
            xml_reply(&xml(&item("/calendar/ack.ics", "&quot;desired&quot;"))),
            Duration::ZERO,
        ),
        (get_reply("\"desired\"", &desired), Duration::ZERO),
        (
            xml_reply(&xml(&item("/calendar/ack.ics", "&quot;desired&quot;"))),
            Duration::ZERO,
        ),
        (get_reply("\"desired\"", &desired), Duration::ZERO),
    ])
    .await;
    let a = HttpAdapter::loopback_fixture(
        "fixture:todos",
        &format!("{}/calendar/", s.url),
        Duration::from_millis(200),
    )
    .unwrap();
    let status = app.planner_dispatch(id, &a).await.unwrap();
    let rejected = code == 412;
    assert_eq!(
        status["phase"],
        if rejected { "conflict" } else { "synced" },
        "{case}: {status}"
    );
    assert_eq!(status["remote_applied"], !rejected, "{case}");
    assert_eq!(
        status["write_outcome"],
        if rejected {
            "precondition_failed"
        } else {
            "unknown"
        },
        "{case}"
    );
    assert_eq!(
        app.planner_dispatch(id, &a).await.unwrap(),
        status,
        "terminal dispatch cannot resend"
    );
    app.planner_pull("todos", &a).await.unwrap();
    let current = super::super::status(&app.lock().unwrap(), id, "todos").unwrap();
    for field in [
        "phase",
        "remote_applied",
        "write_outcome",
        "operation_id",
        "uid",
        "conflict",
    ] {
        assert_eq!(
            current[field], status[field],
            "desired full pull preserves {field}"
        );
    }
    assert_eq!(
        app.action(serde_json::from_value(command).unwrap())
            .unwrap(),
        original_admission
    );
    assert_eq!(
        super::super::admission_receipt(&app.lock().unwrap().journal.0, id).unwrap(),
        original_admission["result"]
    );
    let cached = super::super::resource(&app.lock().unwrap().journal.0, "todos", "ack")
        .unwrap()
        .unwrap();
    assert_eq!(cached.raw.as_deref(), Some(desired.as_str()));
    {
        let log = s.log.lock().unwrap();
        assert_eq!(log.iter().filter(|r| r.method == "PUT").count(), 1);
        assert_eq!(log[0].headers["if-match"], "\"seed\"");
        assert_eq!(log.len(), 5);
    }
    eprintln!(
        "CALDAV_ACK_STATUS {}",
        serde_json::json!({"case":case,"http_status":code,"live_status":status,"put_count":1,"admission_unchanged":true,"desired_observed":true})
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn caldav_http_412_truncated_body_keeps_conflict_despite_desired_readback() {
    broken_acknowledgement_preserves_status("truncated", 412).await;
}
#[tokio::test]
async fn caldav_http_412_oversize_body_keeps_conflict_despite_desired_readback() {
    broken_acknowledgement_preserves_status("oversize", 412).await;
}
#[tokio::test]
async fn caldav_http_412_delayed_body_keeps_conflict_despite_desired_readback() {
    broken_acknowledgement_preserves_status("delayed", 412).await;
}
#[tokio::test]
async fn caldav_http_broken_2xx_acknowledgement_stays_unknown_until_readback() {
    for case in ["truncated", "oversize", "delayed"] {
        broken_acknowledgement_preserves_status(case, 201).await;
    }
}
fn item(href: &str, etag: &str) -> String {
    format!("<D:response><D:href>{href}</D:href><D:propstat><D:prop><D:resourcetype/><D:getetag>{etag}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>")
}
fn xml(items: &str) -> String {
    format!("<D:multistatus xmlns:D=\"DAV:\" xmlns:C=\"urn:ietf:params:xml:ns:caldav\">{}{items}</D:multistatus>",root())
}
fn adapter(server: &Scripted) -> HttpAdapter {
    HttpAdapter::loopback_fixture(
        "fixture:todos",
        &format!("{}/calendar/", server.url),
        Duration::from_secs(1),
    )
    .unwrap()
}
async fn server(responses: Vec<String>) -> Scripted {
    Scripted::start(responses.into_iter().map(|r| (r, Duration::ZERO)).collect()).await
}
fn xml_reply(body: &str) -> String {
    reply(207, "Content-Type: application/xml\r\n", body)
}
fn get_reply(etag: &str, raw: &str) -> String {
    reply(
        200,
        &format!("Content-Type: text/calendar\r\nETag: {etag}\r\n"),
        raw,
    )
}

#[test]
fn caldav_http_single_entity_tag_grammar_classifies_all_octets_without_lists() {
    use super::super::{etag_valid, parse_entity_tag, EntityTagStrength::*};
    for byte in 0u8..=255 {
        let input = [b'"', byte, b'"'];
        let allowed = byte == 0x21 || (0x23..=0x7e).contains(&byte) || byte >= 0x80;
        assert_eq!(
            parse_entity_tag(&input),
            allowed.then_some(Strong),
            "octet {byte:02x}"
        );
    }
    for tag in [
        "\"\"",
        "\"base\"",
        "\"base,other\"",
        "\"back\\slash\"",
        "\"café\"",
    ] {
        assert_eq!(parse_entity_tag(tag.as_bytes()), Some(Strong));
        assert!(etag_valid(tag));
        let weak = format!("W/{tag}");
        assert_eq!(parse_entity_tag(weak.as_bytes()), Some(Weak));
        assert!(!etag_valid(&weak));
    }
    for invalid in [
        "",
        "\"",
        "base",
        "*",
        "w/\"base\"",
        " W/\"base\"",
        "\"base\" ",
        "\"base\", \"other\"",
        "\"base\",\"other\"",
        "\"a\"b\"",
        "\"a b\"",
        "\"a\tb\"",
        "\"a\r\nb\"",
        "\"a\u{0000}b\"",
        "\"a\u{007f}b\"",
        "W/\"base\", \"other\"",
    ] {
        assert!(
            parse_entity_tag(invalid.as_bytes()).is_none(),
            "{invalid:?}"
        );
        assert!(!etag_valid(invalid));
    }
    assert!(parse_entity_tag(format!("\"{}\"", "a".repeat(511)).as_bytes()).is_none());
}

#[tokio::test]
async fn caldav_http_malformed_listing_and_get_etags_never_admit_writable_base_or_put() {
    let raw = ics("badtag", Kind::Todo, "");
    for tag in [
        "\"base\", \"other\"",
        "\"a\"b\"",
        "\"a\tb\"",
        "\"a\u{007f}b\"",
    ] {
        for at_listing in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let app =
                Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
            configure_fixture(&app, "todos", Kind::Todo, vec![]);
            let encoded = tag.replace('"', "&quot;");
            let listing = xml_reply(&xml(&item(
                "/calendar/badtag.ics",
                if at_listing {
                    &encoded
                } else {
                    "&quot;base&quot;"
                },
            )));
            let s = server(if at_listing {
                vec![listing]
            } else {
                vec![listing, get_reply(tag, &raw)]
            })
            .await;
            let a = adapter(&s);
            assert!(
                app.planner_pull("todos", &a).await.is_err(),
                "{tag:?}/{at_listing}"
            );
            assert!(
                super::super::resource(&app.lock().unwrap().journal.0, "todos", "badtag")
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                owner(
                    &app,
                    OwnerAction::PlannerMutation {
                        mutation: mutation(
                            "todos",
                            Some("badtag"),
                            Some(1),
                            Verb::Patch,
                            serde_json::json!({"title":"unsafe"})
                        )
                    }
                )["ok"],
                false
            );
            assert!(a
                .write(ConditionalWrite {
                    uid: "badtag".into(),
                    href: "badtag.ics".into(),
                    raw: Some(raw.clone()),
                    condition: Condition::Match(tag.into())
                })
                .await
                .is_err());
            {
                let log = s.log.lock().unwrap();
                assert_eq!(log.len(), if at_listing { 1 } else { 2 });
                assert_eq!(log.iter().filter(|r| r.method == "PUT").count(), 0);
            }
            app.shutdown().await.unwrap();
        }
    }
    let s = server(vec![
        xml_reply(&xml(&item("/calendar/badtag.ics", "&quot;base&quot;"))),
        reply(
            200,
            "Content-Type: text/calendar\r\nETag: \"base\"\r\nETag: \"other\"\r\n",
            &raw,
        ),
    ])
    .await;
    assert!(
        adapter(&s).inventory().await.is_err(),
        "duplicate response ETag fields are not a single tag"
    );
    assert_eq!(
        s.log
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == "PUT")
            .count(),
        0
    );
}

#[tokio::test]
async fn caldav_http_valid_strong_and_weak_tags_preserve_raw_but_weak_is_read_only() {
    for tag in ["\"base\"", "\"café\"", "W/\"weak\""] {
        let root = tempfile::tempdir().unwrap();
        let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
        configure_fixture(&app, "todos", Kind::Todo, vec![]);
        let raw = ics("validtag", Kind::Todo, "");
        let encoded = tag.replace('"', "&quot;");
        let s = server(vec![
            xml_reply(&xml(&item("/calendar/validtag.ics", &encoded))),
            get_reply(tag, &raw),
        ])
        .await;
        let a = adapter(&s);
        app.planner_pull("todos", &a).await.unwrap();
        let r = super::super::resource(&app.lock().unwrap().journal.0, "todos", "validtag")
            .unwrap()
            .unwrap();
        assert_eq!(r.raw.as_deref(), Some(raw.as_str()));
        assert_eq!(r.etag.as_deref(), Some(tag));
        let weak = tag.starts_with("W/");
        assert_eq!(r.read_only, weak);
        let admission = owner(
            &app,
            OwnerAction::PlannerMutation {
                mutation: mutation(
                    "todos",
                    Some("validtag"),
                    Some(r.version),
                    Verb::Patch,
                    serde_json::json!({"title":"owner change"}),
                ),
            },
        );
        assert_eq!(admission["ok"], !weak);
        if weak {
            assert!(a
                .write(ConditionalWrite {
                    uid: "validtag".into(),
                    href: "validtag.ics".into(),
                    raw: Some(raw.clone()),
                    condition: Condition::Match(tag.into())
                })
                .await
                .is_err());
        }
        assert_eq!(
            s.log
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.method == "PUT")
                .count(),
            0
        );
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn caldav_http_adapter_independent_malformed_tag_cannot_enter_host_cache() {
    let root = tempfile::tempdir().unwrap();
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    configure_fixture(&app, "todos", Kind::Todo, vec![]);
    let remote = Synthetic::new("fixture:todos");
    remote.seed("cached", ics("cached", Kind::Todo, ""));
    app.planner_pull("todos", &remote).await.unwrap();
    let before = super::super::resource(&app.lock().unwrap().journal.0, "todos", "cached")
        .unwrap()
        .unwrap();
    for tag in ["\"base\", \"other\"", "\"a\"b\"", "\"a\tb\""] {
        remote.items.lock().unwrap().get_mut("cached").unwrap().etag = tag.into();
        assert!(app.planner_pull("todos", &remote).await.is_err());
        let after = super::super::resource(&app.lock().unwrap().journal.0, "todos", "cached")
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(&after).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
    }
    assert!(remote.requests.lock().unwrap().is_empty());
    app.shutdown().await.unwrap();
}

#[test]
fn caldav_http_endpoint_tls_and_href_policy_is_fail_closed() {
    for endpoint in [
        "http://example.com/calendar/",
        "http://127.0.0.1:1234/calendar/",
        "https://user:pass@example.com/calendar/",
        "https://example.com/",
        "https://example.com/cal/../calendar/",
        "https://example.com/calendar/?key=x",
    ] {
        assert!(
            HttpAdapter::https("binding", endpoint, SyncPhase::ExplicitActive).is_err(),
            "{endpoint}"
        );
    }
    let a = HttpAdapter::https("binding", "https://example.com/calendar/", SyncPhase::ExplicitActive)
        .unwrap();
    for href in [
        "https://other.example/calendar/a.ics",
        "https://example.com:8443/calendar/a.ics",
        "http://example.com/calendar/a.ics",
        "//other.example/calendar/a.ics",
        "/outside/a.ics",
        "/calendar-other/a.ics",
        "../calendar/a.ics",
        "/calendar/../calendar/a.ics",
        "/calendar/a%2Fz.ics",
        "/calendar/%2e%2e/a.ics",
        "/calendar/sub/a.ics",
        "a.ics?token=x",
        "a.ics#part",
        "a\\b.ics",
        "/calendar/a.ics\n",
    ] {
        assert!(a.resolve_href(href).is_err(), "{href}");
    }
    for href in [
        "a.ics",
        "/calendar/a.ics",
        "https://example.com/calendar/a.ics",
    ] {
        assert_eq!(a.resolve_href(href).unwrap().1.as_deref(), Some("a.ics"));
    }
    assert!(HttpAdapter::loopback_fixture(
        "binding",
        "http://192.0.2.1/calendar/",
        Duration::from_secs(1)
    )
    .is_err());
}
#[test]
fn caldav_http_xml_namespaces_partial_dtd_and_duplicates_are_rejected() {
    let a = HttpAdapter::https("binding", "https://example.com/calendar/", SyncPhase::ExplicitActive)
        .unwrap();
    assert_eq!(
        a.parse_listing(&xml(&item("/calendar/a.ics", "&quot;e&quot;")))
            .unwrap()
            .len(),
        1
    );
    let failures = [
        "<D:multistatus xmlns:D=\"DAV:\">".to_string(),
        "<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><x>&e;</x>".into(),
        "<!DOCTYPE x><x/>".into(),
        xml("").replace("DAV:", "urn:fake"),
        "<D:multistatus xmlns:D=\"DAV:\"/>".into(),
        xml(&item("/calendar/a.ics", "&quot;e&quot;")).replace("200 OK", "404 Not Found"),
        xml(&item("/calendar/a.ics", "&quot;e&quot;").repeat(2)),
        xml(&item("/outside/a.ics", "&quot;e&quot;")),
        xml(&item(
            "https://elsewhere.example/calendar/a.ics",
            "&quot;e&quot;",
        )),
        xml("").replace("<D:collection/><C:calendar/>", "<D:collection/>"),
        xml("").replace(
            "<D:href>/calendar/</D:href>",
            "<D:href>/calendar/<!--split-->a.ics</D:href>",
        ),
        xml("").replace("<D:propstat>", "<D:propstat><D:error/>"),
    ];
    for body in failures {
        assert!(
            a.parse_listing(&body).is_err(),
            "unexpected accepted XML: {body}"
        );
    }
    assert!(a
        .parse_listing(&format!(
            "<D:multistatus xmlns:D=\"DAV:\" xml:base=\"/other/\">{}</D:multistatus>",
            root()
        ))
        .is_err());
    let oversized = xml(&item("/calendar/a.ics", "&quot;e&quot;").repeat(MAX_ITEMS + 1));
    assert!(a.parse_listing(&oversized).is_err());
}

#[tokio::test]
async fn caldav_http_full_inventory_uses_get_bytes_etag_and_depth_one_without_window() {
    let raw = ics("a", Kind::Todo, "X-OPAQUE:keep me\r\nRRULE:FREQ=WEEKLY\r\n");
    let s = server(vec![
        xml_reply(&xml(&item("/calendar/a.ics", "&quot;e&quot;"))),
        get_reply("\"e\"", &raw),
    ])
    .await;
    let inv = adapter(&s).inventory().await.unwrap();
    assert!(inv.complete);
    assert_eq!(inv.items[0].raw, raw);
    assert_eq!(inv.items[0].uid, "a");
    let log = s.log.lock().unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].method, "PROPFIND");
    assert_eq!(log[0].headers["depth"], "1");
    assert_eq!(log[1].method, "GET");
    assert!(!String::from_utf8_lossy(&log[0].body).contains("time-range"));
}
#[tokio::test]
async fn caldav_http_404_auth_partial_redirect_and_changed_etag_never_mean_uid_absence() {
    for status in [301, 302, 307, 401, 403, 404, 500] {
        let s = server(vec![reply(
            status,
            "Location: http://127.0.0.1:1/elsewhere\r\n",
            "",
        )])
        .await;
        assert!(
            adapter(&s).observe_uid("a").await.is_err(),
            "status {status}"
        );
        assert_eq!(s.log.lock().unwrap().len(), 1, "redirect never followed");
    }
    for second in [
        reply(404, "", ""),
        get_reply("\"changed\"", &ics("a", Kind::Todo, "")),
        get_reply("\"e\"", "broken data"),
        get_reply(
            "\"e\"",
            &ics("different", Kind::Todo, "").replace("UID:different", "UID:"),
        ),
    ] {
        let s = server(vec![
            xml_reply(&xml(&item("/calendar/a.ics", "&quot;e&quot;"))),
            second,
        ])
        .await;
        assert!(adapter(&s).observe_uid("a").await.is_err());
    }
    let s = server(vec![xml_reply(&xml(""))]).await;
    assert!(
        adapter(&s).observe_uid("a").await.unwrap().is_none(),
        "only fresh complete collection scan establishes absence"
    );
}
#[tokio::test]
async fn caldav_http_body_size_truncation_encoding_and_timeout_are_bounded() {
    let oversized=format!("HTTP/1.1 207 Fixture\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",MAX_XML+1);
    let truncated="HTTP/1.1 207 Fixture\r\nContent-Type: application/xml\r\nContent-Length: 100\r\nConnection: close\r\n\r\n<broken>".to_string();
    let chunked=format!("HTTP/1.1 207 Fixture\r\nContent-Type: application/xml\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",MAX_XML+1,"x".repeat(MAX_XML+1));
    for response in [
        oversized,
        truncated,
        chunked,
        reply(
            207,
            "Content-Type: application/xml\r\nContent-Encoding: gzip\r\n",
            &xml(""),
        ),
        reply(207, "Content-Type: text/html\r\n", &xml("")),
    ] {
        let s = server(vec![response]).await;
        assert!(adapter(&s).inventory().await.is_err());
    }
    let s = Scripted::start(vec![(xml_reply(&xml("")), Duration::from_secs(2))]).await;
    let a = HttpAdapter::loopback_fixture(
        "binding",
        &format!("{}/calendar/", s.url),
        Duration::from_millis(40),
    )
    .unwrap();
    let started = std::time::Instant::now();
    assert!(a.inventory().await.is_err());
    assert!(started.elapsed() < Duration::from_secs(1));
}
#[tokio::test]
async fn caldav_http_conditional_headers_and_412_outcome_use_actual_http() {
    let s = server(vec![
        reply(201, "", ""),
        reply(204, "", ""),
        reply(412, "", ""),
        reply(204, "", ""),
    ])
    .await;
    let a = adapter(&s);
    let raw = ics("a", Kind::Todo, "");
    for (condition, body, expected) in [
        (Condition::Absent, Some(raw.clone()), "applied"),
        (
            Condition::Match("\"e\"".into()),
            Some(raw.clone()),
            "applied",
        ),
        (Condition::Match("\"e\"".into()), Some(raw), "412"),
        (Condition::Match("\"e2\"".into()), None, "applied"),
    ] {
        let result = a
            .write(ConditionalWrite {
                uid: "a".into(),
                href: "a.ics".into(),
                raw: body,
                condition,
            })
            .await
            .unwrap();
        assert!(matches!(
            (result, expected),
            (WriteOutcome::Applied, "applied") | (WriteOutcome::PreconditionFailed, "412")
        ));
    }
    let log = s.log.lock().unwrap();
    assert_eq!(log[0].headers["if-none-match"], "*");
    assert_eq!(log[1].headers["if-match"], "\"e\"");
    assert_eq!(log[2].headers["if-match"], "\"e\"");
    assert_eq!(log[3].method, "DELETE");
    assert_eq!(log[3].headers["if-match"], "\"e2\"");
}
#[tokio::test]
async fn caldav_http_invalid_mutation_and_unknown_schema_never_send() {
    let s = server(vec![reply(500, "", "")]).await;
    let a = adapter(&s);
    for (condition, raw, href) in [
        (
            Condition::Match("W/\"weak\"".into()),
            Some(ics("a", Kind::Todo, "")),
            "a.ics",
        ),
        (Condition::Absent, None, "a.ics"),
        (
            Condition::Absent,
            Some(ics(
                "a",
                Kind::Todo,
                "ATTENDEE:mailto:external@example.invalid\r\n",
            )),
            "a.ics",
        ),
        (
            Condition::Absent,
            Some(ics("a", Kind::Todo, "RRULE:FREQ=DAILY\r\n")),
            "a.ics",
        ),
        (Condition::Absent, Some(ics("b", Kind::Todo, "")), "a.ics"),
        (
            Condition::Absent,
            Some(ics("a", Kind::Todo, "")),
            "../a.ics",
        ),
    ] {
        assert!(a
            .write(ConditionalWrite {
                uid: "a".into(),
                href: href.into(),
                raw,
                condition
            })
            .await
            .is_err());
    }
    assert!(s.log.lock().unwrap().is_empty());
}
#[tokio::test]
async fn caldav_http_supported_canonical_readback_matches_goal_unknown_does_not() {
    for unsupported in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
        configure_fixture(&app, "todos", Kind::Todo, vec![]);
        let admission = owner(
            &app,
            OwnerAction::PlannerMutation {
                mutation: mutation(
                    "todos",
                    None,
                    None,
                    Verb::Create,
                    serde_json::json!({"title":"canonical","due":"2026-10-03"}),
                ),
            },
        );
        let id = admission["result"]["operation_id"].as_str().unwrap();
        let uid = admission["result"]["uid"].as_str().unwrap();
        let op: super::super::Operation =
            super::super::load(&app.lock().unwrap().journal.0, "planner_operations", id)
                .unwrap()
                .unwrap();
        let mut lines = op
            .desired_raw
            .as_ref()
            .unwrap()
            .split("\r\n")
            .map(str::to_string)
            .collect::<Vec<_>>();
        let uid_pos = lines.iter().position(|l| l.starts_with("UID:")).unwrap();
        let line = lines.remove(uid_pos);
        let end = lines.iter().position(|l| l == "END:VTODO").unwrap();
        lines.insert(end, line);
        if unsupported {
            let end = lines.iter().position(|l| l == "END:VTODO").unwrap();
            lines.insert(end, "X-SERVER-UNKNOWN:preserve".into());
        }
        let canonical = lines.join("\r\n");
        assert_ne!(Some(&canonical), op.desired_raw.as_ref());
        let leaf = format!("{uid}.ics");
        let xml = xml(&item(&format!("/calendar/{leaf}"), "&quot;e2&quot;"));
        let s = server(vec![
            reply(201, "", ""),
            xml_reply(&xml),
            get_reply("\"e2\"", &canonical),
        ])
        .await;
        let status = app.planner_dispatch(id, &adapter(&s)).await.unwrap();
        assert_eq!(
            status["phase"],
            if unsupported { "conflict" } else { "synced" }
        );
        assert_eq!(status["remote_applied"], !unsupported);
        let resource = super::super::resource(&app.lock().unwrap().journal.0, "todos", uid)
            .unwrap()
            .unwrap();
        assert_eq!(resource.raw.as_deref(), Some(canonical.as_str()));
        assert_eq!(resource.read_only, unsupported);
        assert_eq!(s.log.lock().unwrap().len(), 3);
        app.shutdown().await.unwrap();
    }
}
