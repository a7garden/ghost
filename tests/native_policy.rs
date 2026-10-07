use ghost::native_http::{public_ip, EndpointApproval, MemoryCredential, Preset};
use ghost::provider_control::{CallFailure, FailureKind, OutcomeClass};

#[test]
fn endpoints_require_exact_host_preset_approval() {
    for preset in [Preset::OpenAi, Preset::Zai] {
        assert!(EndpointApproval::approve(preset, preset.endpoint()).is_ok());
        for endpoint in [
            "http://api.openai.com/v1/chat/completions",
            "https://evil.example/v1/chat/completions",
            "http://169.254.169.254/latest/meta-data",
            "https://127.0.0.1/v1/chat/completions",
            "https://user:password@api.openai.com/v1/chat/completions",
            "https://api.openai.com/v1/chat/completions?secret=fixture",
            "https://api.openai.com/v1/chat/completions#fragment",
            "https://api.openai.com:443/v1/chat/completions",
        ] {
            let error = EndpointApproval::approve(preset, endpoint).unwrap_err();
            let failure = error.downcast_ref::<CallFailure>().unwrap();
            assert_eq!(failure.kind, FailureKind::Policy);
            assert_eq!(failure.outcome, OutcomeClass::NotSent);
            assert!(!error.to_string().contains(endpoint));
        }
    }
    assert!(EndpointApproval::approve(Preset::OpenAi, Preset::Zai.endpoint()).is_err());
    assert!(EndpointApproval::approve(Preset::Zai, Preset::OpenAi.endpoint()).is_err());
}

#[test]
fn address_filter_blocks_private_mapped_and_special_addresses() {
    for address in [
        "0.0.0.0",
        "10.0.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "100.64.0.1",
        "198.18.0.1",
        "192.0.2.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "2001:db8::1",
        "2002:7f00:1::1",
    ] {
        assert!(!public_ip(address.parse().unwrap()), "{address}");
    }
    for address in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
        assert!(public_ip(address.parse().unwrap()));
    }
}

#[test]
fn credential_debug_and_errors_never_include_the_value() {
    let value = "public-dummy-secret-policy";
    let credential = MemoryCredential::new(value.into()).unwrap();
    assert!(!format!("{credential:?}").contains(value));
    let error = MemoryCredential::new("invalid\nfixture".into())
        .err()
        .unwrap();
    assert!(!error.to_string().contains("fixture"));
}

#[test]
fn outcome_class_controls_terminal_state_without_replay_permission() {
    assert_eq!(
        CallFailure::new(FailureKind::Cancelled, OutcomeClass::NotSent).task_status(),
        "cancelled"
    );
    assert_eq!(
        CallFailure::new(FailureKind::Cancelled, OutcomeClass::Uncertain).task_status(),
        "uncertain"
    );
    assert_eq!(
        CallFailure::new(FailureKind::Policy, OutcomeClass::NotSent).task_status(),
        "denied"
    );
    assert_eq!(
        CallFailure::new(FailureKind::RateLimit, OutcomeClass::Rejected).task_status(),
        "failed"
    );
}
