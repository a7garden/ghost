#![cfg(feature = "lifetime")]

use ghost::{
    lifetime_contract::Artifact,
    operations::artifact_verifier::verify_artifact,
};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const MAX_ARTIFACT_BYTES: usize = 1024 * 1024;
const EXECUTION: &str = "verifier-boundary-attempt";

struct Fixture {
    _temporary: TempDir,
    worker_root: PathBuf,
    execution: String,
    artifact: Artifact,
    path: PathBuf,
}

impl Fixture {
    fn new(contents: &[u8]) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let worker_root = temporary.path().join("worker");
        let execution = EXECUTION.to_owned();
        let digest = digest(contents);
        let path = artifact_path(&worker_root, &execution, &digest);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
        let artifact = Artifact {
            digest,
            locator: path.to_string_lossy().into_owned(),
            privacy: "local_only".to_owned(),
            producing_attempt: execution.clone(),
        };
        Self {
            _temporary: temporary,
            worker_root,
            execution,
            artifact,
            path,
        }
    }

    fn verify(&self, expected_contents: &[u8]) -> anyhow::Result<()> {
        verify_artifact(
            &self.worker_root,
            &self.artifact,
            &self.execution,
            expected_contents,
        )
    }
}

fn digest(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
}

fn execution_key(execution: &str) -> String {
    digest(execution.as_bytes())
}

fn artifact_path(root: &Path, execution: &str, digest: &str) -> PathBuf {
    root.join("artifacts")
        .join(execution_key(execution))
        .join(format!("{digest}.json"))
}

#[test]
fn accepts_raw_non_json_bytes_at_the_exact_one_mib_limit() {
    let contents = vec![0xff; MAX_ARTIFACT_BYTES];
    let fixture = Fixture::new(&contents);
    assert!(fixture.verify(&contents).is_ok());
}

#[test]
fn rejects_an_oversized_file_even_when_the_expected_prefix_is_bounded() {
    let contents = vec![0x5a; MAX_ARTIFACT_BYTES + 1];
    let fixture = Fixture::new(&contents);
    assert!(fixture.verify(&contents[..MAX_ARTIFACT_BYTES]).is_err());
}

#[test]
fn rejects_expected_bytes_that_differ_when_the_file_hash_is_valid() {
    let actual = b"the digest is valid for these bytes";
    let fixture = Fixture::new(actual);
    assert!(fixture.verify(b"different expected bytes").is_err());
}

#[test]
fn rejects_a_forged_digest_when_actual_bytes_match_the_expectation() {
    let contents = b"correct bytes with a false producer digest claim";
    let mut fixture = Fixture::new(contents);
    let forged_digest = "0".repeat(64);
    let forged_path = artifact_path(&fixture.worker_root, &fixture.execution, &forged_digest);
    std::fs::rename(&fixture.path, &forged_path).unwrap();
    fixture.artifact.digest = forged_digest;
    fixture.artifact.locator = forged_path.to_string_lossy().into_owned();

    assert!(fixture.verify(contents).is_err());
}

#[test]
fn forged_producer_digest_cannot_override_mutated_artifact_bytes() {
    let claimed_contents = b"producer supplied a passing digest and execution claim";
    let fixture = Fixture::new(claimed_contents);
    let mut tampered = claimed_contents.to_vec();
    tampered[0] ^= 1;
    std::fs::write(&fixture.path, tampered).unwrap();

    assert!(fixture.verify(claimed_contents).is_err());
}

#[test]
fn rejects_an_artifact_from_another_execution() {
    let mut fixture = Fixture::new(b"execution-scoped bytes");
    fixture.artifact.producing_attempt = "different-attempt".to_owned();
    assert!(fixture.verify(b"execution-scoped bytes").is_err());
}

#[test]
fn rejects_malformed_digest_and_foreign_locator() {
    let contents = b"locator boundaries";
    let mut malformed = Fixture::new(contents);
    malformed.artifact.digest = "../outside".to_owned();
    assert!(malformed.verify(contents).is_err());

    let mut foreign = Fixture::new(contents);
    foreign.artifact.locator = foreign
        .worker_root
        .join("outside.json")
        .to_string_lossy()
        .into_owned();
    assert!(foreign.verify(contents).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_worker_root_and_artifact_parents() {
    use std::os::unix::fs::symlink;

    let mut root_fixture = Fixture::new(b"root symlink");
    let root_alias = root_fixture._temporary.path().join("worker-link");
    symlink(&root_fixture.worker_root, &root_alias).unwrap();
    root_fixture.artifact.locator = artifact_path(
        &root_alias,
        &root_fixture.execution,
        &root_fixture.artifact.digest,
    )
    .to_string_lossy()
    .into_owned();
    assert!(verify_artifact(
        &root_alias,
        &root_fixture.artifact,
        &root_fixture.execution,
        b"root symlink",
    )
    .is_err());

    let artifacts_fixture = Fixture::new(b"artifacts parent symlink");
    let artifacts = artifacts_fixture.worker_root.join("artifacts");
    let moved_artifacts = artifacts_fixture._temporary.path().join("moved-artifacts");
    std::fs::rename(&artifacts, &moved_artifacts).unwrap();
    symlink(&moved_artifacts, &artifacts).unwrap();
    assert!(artifacts_fixture
        .verify(b"artifacts parent symlink")
        .is_err());

    let execution_fixture = Fixture::new(b"execution parent symlink");
    let execution_directory = execution_fixture.path.parent().unwrap();
    let moved_execution_directory = execution_fixture._temporary.path().join("moved-execution");
    std::fs::rename(execution_directory, &moved_execution_directory).unwrap();
    symlink(&moved_execution_directory, execution_directory).unwrap();
    assert!(execution_fixture
        .verify(b"execution parent symlink")
        .is_err());
}

#[cfg(unix)]
#[test]
fn rejects_final_symlinks_hard_links_and_non_regular_files() {
    use std::os::unix::fs::symlink;

    let symlink_fixture = Fixture::new(b"final symlink");
    let target = symlink_fixture._temporary.path().join("target");
    std::fs::write(&target, b"final symlink").unwrap();
    std::fs::remove_file(&symlink_fixture.path).unwrap();
    symlink(&target, &symlink_fixture.path).unwrap();
    assert!(symlink_fixture.verify(b"final symlink").is_err());

    let hard_link_fixture = Fixture::new(b"hard link");
    let hard_link = hard_link_fixture._temporary.path().join("second-link");
    std::fs::hard_link(&hard_link_fixture.path, &hard_link).unwrap();
    assert!(hard_link_fixture.verify(b"hard link").is_err());

    let non_regular_fixture = Fixture::new(b"not a regular file");
    std::fs::remove_file(&non_regular_fixture.path).unwrap();
    std::fs::create_dir(&non_regular_fixture.path).unwrap();
    assert!(non_regular_fixture.verify(b"not a regular file").is_err());
}
