use anyhow::{anyhow, bail, ensure, Result};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs::File,
    future::Future,
    io::Read,
    path::{Path, PathBuf},
    pin::Pin,
    time::{Duration, SystemTime},
};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum GoogleScope {
    CalendarEventsReadOnly,
    CalendarEvents,
    TasksReadOnly,
    Tasks,
}

impl GoogleScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CalendarEventsReadOnly => "https://www.googleapis.com/auth/calendar.events.readonly",
            Self::CalendarEvents => "https://www.googleapis.com/auth/calendar.events",
            Self::TasksReadOnly => "https://www.googleapis.com/auth/tasks.readonly",
            Self::Tasks => "https://www.googleapis.com/auth/tasks",
        }
    }

    /// Exact scope-URL parsing for lease stores; unknown scopes are refused
    /// rather than silently ignored.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            value if value == Self::CalendarEventsReadOnly.as_str() => Self::CalendarEventsReadOnly,
            value if value == Self::CalendarEvents.as_str() => Self::CalendarEvents,
            value if value == Self::TasksReadOnly.as_str() => Self::TasksReadOnly,
            value if value == Self::Tasks.as_str() => Self::Tasks,
            _ => return None,
        })
    }

    fn grants_storage(self) -> Option<Self> {
        match self {
            Self::CalendarEventsReadOnly => Some(Self::CalendarEvents),
            Self::TasksReadOnly => Some(Self::Tasks),
            Self::CalendarEvents | Self::Tasks => None,
        }
    }
}

/// Short-lived access lease from the Host-owned Google credential store.
/// It intentionally has no `Debug`, `Clone`, or serialization implementation.
pub struct GoogleTokenLease {
    account_ref: String,
    access_token: String,
    expires_at: SystemTime,
    scopes: BTreeSet<GoogleScope>,
}

impl GoogleTokenLease {
    pub fn new(
        account_ref: String,
        access_token: String,
        expires_at: SystemTime,
        scopes: impl IntoIterator<Item = GoogleScope>,
    ) -> Self {
        Self {
            account_ref,
            access_token,
            expires_at,
            scopes: scopes.into_iter().collect(),
        }
    }

    pub fn account_ref(&self) -> &str {
        &self.account_ref
    }

    pub(crate) fn access_token(&self) -> &str {
        &self.access_token
    }

    pub(crate) fn expires_at(&self) -> SystemTime {
        self.expires_at
    }

    pub(crate) fn grants(&self, scope: GoogleScope) -> bool {
        self.scopes.contains(&scope)
            || scope
                .grants_storage()
                .is_some_and(|storage| self.scopes.contains(&storage))
    }
}

pub type GoogleTokenLeaseFuture<'a> =
    Pin<Box<dyn Future<Output = Result<GoogleTokenLease>> + Send + 'a>>;

/// Host-selected, account-bound credential lease. Implementations must not
/// serialize credentials or expose them in diagnostics.
pub trait GoogleTokenLeaseProvider: Send + Sync {
    fn lease<'a>(
        &'a self,
        account_ref: &'a str,
        required_scopes: &'a [GoogleScope],
    ) -> GoogleTokenLeaseFuture<'a>;
}

/// Host-owned durable lease store. One private file binds exactly one Google
/// account reference to its current token lease; the Host never accepts tokens
/// from prompts, model output, or an alternative store. Every lifecycle
/// operation (Host refresh, CLI login/revoke) synchronizes through a private
/// `<store>.lock` sibling and commits by compare-and-swap against the store's
/// content generation.
pub const TOKEN_STORE_ENV: &str = "GHOST_GOOGLE_TOKEN_STORE";
/// Owner-configured OAuth client credentials for the installed-app flow.
pub const OAUTH_CLIENT_ENV: &str = "GHOST_GOOGLE_OAUTH_CLIENT";

const LEASE_SCHEMA: &str = "ghost-google-lease/1";
const CLIENT_SCHEMA: &str = "ghost-google-oauth-client/1";
const MAX_STORE_BYTES: u64 = 64 * 1024;
const MAX_CLIENT_BYTES: u64 = 64 * 1024;
const LEASE_CLOCK_SKEW: Duration = Duration::from_secs(30);
const MAX_TOKEN_BYTES: usize = 8_192;
const AUTH_ORIGIN: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ORIGIN: &str = "https://oauth2.googleapis.com/token";
const REVOKE_ORIGIN: &str = "https://oauth2.googleapis.com/revoke";
/// One absolute wall-clock bound for the whole consent window: accepting,
/// reading, parsing and answering every callback happens inside it.
const CONSENT_DEADLINE: Duration = Duration::from_secs(600);
/// Absolute per-callback bound for reading, classifying and answering one
/// request, so a slow peer cannot monopolize the single reader.
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const LOCK_ATTEMPTS: usize = 8;
const REFRESH_CAS_ATTEMPTS: usize = 3;

fn safe_account_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredLease {
    schema: String,
    account_ref: String,
    access_token: String,
    expires_at_ms: i64,
    scopes: Vec<String>,
    #[serde(default)]
    refresh_token: Option<String>,
}

/// Read-only view of a stored lease used for status and connection states.
/// `account_ref` is the owner-assigned local label the store was provisioned
/// with; it is never verified against the Google account identity, and the
/// lease carries no userinfo scope that could attest one.
pub struct StoredLeaseStatus {
    pub account_ref: String,
    pub scopes: BTreeSet<GoogleScope>,
    pub expires_at: SystemTime,
    pub refreshable: bool,
}

fn stored_leases_path() -> Result<PathBuf> {
    let path = std::env::var_os(TOKEN_STORE_ENV)
        .ok_or_else(|| anyhow!("explicit Google token store is not configured ({TOKEN_STORE_ENV})"))?;
    let path = PathBuf::from(path);
    ensure!(path.is_absolute(), "Google token store path must be absolute");
    Ok(path)
}

// ---------------------------------------------------------------------------
// Descriptor-pinned credential containment (unix + libc feature).
//
// The canonical parent chain is resolved once and then re-opened component by
// component with O_NOFOLLOW, so the final handle is pinned to one inode: every
// later entry operation (`openat`/`renameatx_np`/`unlinkat`) is relative to
// that descriptor and can never traverse a swapped path. Each component must
// be a real directory owned by the running user or root, not group- or
// other-writable, and free of ALLOW extended ACLs; credential files must be
// 0600, singly linked, owned by the running user, and ACL-checked before any
// secret byte is read or written. Darwin extended ACLs can expose a 0600 file
// or allow renames inside a 0700 directory regardless of POSIX mode bits, so
// they are inspected directly via `acl_get_fd_np`; DENY entries (e.g. the
// common "group:everyone deny delete") are benign and accepted.
// ---------------------------------------------------------------------------
#[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
mod secure_acl {
    use anyhow::{anyhow, ensure, Result};
    use std::os::fd::RawFd;

    // sys/acl.h constants, verified against the macOS SDK.
    const ACL_TYPE_EXTENDED: libc::c_int = 0x0000_0100;
    const ACL_FIRST_ENTRY: libc::c_int = 0;
    const ACL_NEXT_ENTRY: libc::c_int = -1;
    const ACL_EXTENDED_DENY: libc::c_int = 2;

    extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, acl_type: libc::c_int) -> *mut libc::c_void;
        fn acl_get_entry(
            acl: *mut libc::c_void,
            entry_id: libc::c_int,
            entry_p: *mut *mut libc::c_void,
        ) -> libc::c_int;
        fn acl_get_tag_type(entry: *mut libc::c_void, tag_type_p: *mut libc::c_int) -> libc::c_int;
        fn acl_free(obj_p: *mut libc::c_void) -> libc::c_int;
    }

    /// Reject any ALLOW entry on this open descriptor; only DENY entries are
    /// benign. Darwin reports ENOENT for an absent extended ACL; accept it
    /// only on a still-linked regular-file/directory descriptor.
    pub(crate) fn reject_allow_entries(fd: RawFd, what: &str) -> Result<()> {
        let acl = unsafe { acl_get_fd_np(fd, ACL_TYPE_EXTENDED) };
        if acl.is_null() {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::ENOATTR) | Some(libc::ENOENT)) {
                let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
                ensure!(unsafe { libc::fstat(fd, metadata.as_mut_ptr()) } == 0,
                    "{what} ACL absence cannot be verified on this descriptor");
                let metadata = unsafe { metadata.assume_init() };
                let kind = metadata.st_mode & libc::S_IFMT;
                ensure!(metadata.st_nlink > 0 && matches!(kind, libc::S_IFREG | libc::S_IFDIR),
                    "{what} ACL absence is not a linked regular file or directory");
                return Ok(());
            }
            return Err(anyhow!("{what} extended ACL is unreadable: {error}"));
        }
        let validation = (|| -> Result<()> {
        let mut entry_id = ACL_FIRST_ENTRY;
        loop {
            let mut entry: *mut libc::c_void = std::ptr::null_mut();
            if unsafe { acl_get_entry(acl, entry_id, &mut entry) } != 0 {
                let error = std::io::Error::last_os_error();
                ensure!(
                    matches!(error.raw_os_error(), Some(libc::ENOENT) | Some(libc::EINVAL)),
                    "{what} extended ACL scan failed: {error}"
                );
                break;
            }
            let mut tag: libc::c_int = 0;
            ensure!(
                unsafe { acl_get_tag_type(entry, &mut tag) } == 0,
                "{what} extended ACL entry is unreadable"
            );
            ensure!(
                tag == ACL_EXTENDED_DENY,
                "{what} carries an ALLOW extended ACL entry; remove it before credential use"
            );
            entry_id = ACL_NEXT_ENTRY;
        }
            Ok(())
        })();
        let released = unsafe { acl_free(acl) } == 0;
        validation?;
        ensure!(released, "{what} extended ACL could not be released");
        Ok(())
    }
}

/// One validated credential location: a descriptor pinned to the canonical
/// parent directory inode plus a single-component file name. Every credential
/// read, write, removal and lifecycle lock is performed relative to this
/// descriptor, so no sensitive byte is ever addressed through a re-resolved
/// pathname.
#[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
struct TrustedParent {
    directory: File,
    file_name: std::ffi::CString,
}

#[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
fn trusted_parent(path: &Path) -> Result<TrustedParent> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    ensure!(path.is_absolute(), "credential path must be absolute");
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow!("credential path has no file name"))?;
    let file_name = std::ffi::CString::new(file_name.as_bytes())
        .map_err(|_| anyhow!("credential file name contains a NUL byte"))?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("credential parent directory is missing"))?;
    // Resolve the whole parent chain once (e.g. macOS /var -> /private/var);
    // the walk below then pins every canonical component by descriptor and
    // refuses any symlink encountered on the way.
    let canonical = std::fs::canonicalize(parent)
        .map_err(|error| anyhow!("credential parent directory is unavailable: {error}"))?;
    let euid = unsafe { libc::geteuid() };
    let mut fd = std::fs::File::open("/").map_err(|error| anyhow!("/ is unavailable: {error}"))?;
    let mut trusted_components = 0usize;
    for component in canonical.components() {
        let std::path::Component::Normal(name) = component else {
            continue; // the root was opened directly; "." never appears in canonical paths
        };
        let name = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| anyhow!("credential ancestor contains a NUL byte"))?;
        let descriptor = unsafe {
            libc::openat(
                fd.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        ensure!(
            descriptor >= 0,
            "credential ancestor {name:?} is unavailable: {}",
            std::io::Error::last_os_error()
        );
        let opened = unsafe { File::from_raw_fd(descriptor) };
        let metadata = opened.metadata()?;
        ensure!(
            metadata.is_dir(),
            "credential ancestor must be a real directory, not a symlink or special file"
        );
        ensure!(
            metadata.uid() == euid || metadata.uid() == 0,
            "credential ancestor must be owned by the running Ghost user or root"
        );
        ensure!(
            metadata.mode() & 0o022 == 0,
            "credential ancestor must not be group- or other-writable"
        );
        secure_acl::reject_allow_entries(opened.as_raw_fd(), "credential ancestor directory")?;
        trusted_components += 1;
        // Keep the new component pinned and close the previous one.
        drop(std::mem::replace(&mut fd, opened));
    }
    ensure!(
        trusted_components >= 2,
        "credential directory must have an owner-controlled parent, not the filesystem root"
    );
    Ok(TrustedParent {
        directory: fd,
        file_name,
    })
}

/// Validate a credential file through its own open descriptor: the checks are
/// on the exact inode about to be read or written, and any ALLOW extended ACL
/// is rejected before a secret byte moves.
#[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
fn check_private_file_handle(file: &File, what: &str, max_bytes: u64) -> Result<()> {
    use std::os::fd::AsRawFd;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file(),
        "{what} must be a regular file, not a symlink or special file"
    );
    ensure!(metadata.len() <= max_bytes, "{what} exceeds its byte limit");
    ensure!(metadata.nlink() == 1, "{what} must not be hard-linked");
    ensure!(
        metadata.mode() & 0o077 == 0,
        "{what} must not be readable by group or others (chmod 600)"
    );
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() },
        "{what} must be owned by the running Ghost user"
    );
    secure_acl::reject_allow_entries(file.as_raw_fd(), what)
}

/// Read a bounded private file through the pinned parent descriptor. The
/// opened handle is opened no-follow, validated, and the bytes come only from
/// that inode.
#[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
fn read_private_file(path: &TrustedParent, max_bytes: u64) -> Result<Vec<u8>> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let descriptor = unsafe {
        libc::openat(
            path.directory.as_raw_fd(),
            path.file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        // io::Error is preserved so absence can be told apart from hostility.
        return Err(anyhow::Error::new(std::io::Error::last_os_error()));
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    check_private_file_handle(&file, "credential file", max_bytes)?;
    let before = file.metadata()?;
    let mut bytes = Vec::with_capacity(before.len().min(max_bytes) as usize);
    (&file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| anyhow!("credential file could not be read: {error}"))?;
    ensure!(
        bytes.len() as u64 <= max_bytes,
        "credential file exceeds its byte limit"
    );
    let after = file.metadata()?;
    ensure!(
        before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.nlink() == after.nlink()
            && after.len() == bytes.len() as u64,
        "credential file changed while being read"
    );
    Ok(bytes)
}

fn load_store(path: &TrustedParent) -> Result<StoredLease> {
    parse_store(&read_private_file(path, MAX_STORE_BYTES)?)
}

/// Secure read that treats a genuinely absent store as `None`; dangling or
/// hostile entries still fail validation instead of looking absent.
fn load_optional_store(path: &TrustedParent) -> Result<Option<StoredLease>> {
    match read_private_file(path, MAX_STORE_BYTES) {
        Ok(bytes) => Ok(Some(parse_store(&bytes)?)),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// Atomically replace the lease file relative to the pinned parent
/// descriptor. The temporary file is created, tightened to 0600, and
/// ACL-checked through its own descriptor before any secret byte is written;
/// the commit is a `renameatx_np` within the pinned directory — no pathname
/// is ever re-resolved.
#[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
fn write_store(path: &TrustedParent, store: &StoredLease) -> Result<()> {
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd};
    let bytes = serde_json::to_vec_pretty(store)?;
    let temp_name = std::ffi::CString::new(format!(
        ".{}.tmp.{}",
        path.file_name.to_string_lossy(),
        uuid::Uuid::new_v4().simple()
    ))
    .expect("temporary file name has no NUL");
    let descriptor = unsafe {
        libc::openat(
            path.directory.as_raw_fd(),
            temp_name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    ensure!(
        descriptor >= 0,
        "credential temporary file could not be created: {}",
        std::io::Error::last_os_error()
    );
    let mut temp = unsafe { File::from_raw_fd(descriptor) };
    let outcome = (|| {
        // Tighten and validate before the plaintext exists in the file.
        temp.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        check_private_file_handle(&temp, "credential temporary file", u64::MAX)?;
        temp.write_all(&bytes)?;
        temp.sync_all()?;
        let renamed = unsafe {
            libc::renameat(
                path.directory.as_raw_fd(),
                temp_name.as_ptr(),
                path.directory.as_raw_fd(),
                path.file_name.as_ptr(),
            )
        };
        ensure!(
            renamed == 0,
            "credential store could not be committed: {}",
            std::io::Error::last_os_error()
        );
        // Durable replacement: the directory entry must survive crashes.
        path.directory
            .sync_all()
            .map_err(|error| anyhow!("credential store could not be made durable: {error}"))
    })();
    if outcome.is_err() {
        unsafe { libc::unlinkat(path.directory.as_raw_fd(), temp_name.as_ptr(), 0) };
    }
    outcome
}

/// Fail-closed stand-in for builds without the hardened unix containment
/// (plain `host` has no libc): no credential byte is ever touched through an
/// unvalidated path — the operation is refused instead.
#[cfg(not(all(unix, any(feature = "caldav", feature = "lifetime"))))]
struct TrustedParent {
    _unavailable: (),
}

#[cfg(not(all(unix, any(feature = "caldav", feature = "lifetime"))))]
fn containment_unavailable() -> anyhow::Error {
    anyhow!("Google credential containment requires the hardened unix build; rebuild with --features caldav (or lifetime)")
}

#[cfg(not(all(unix, any(feature = "caldav", feature = "lifetime"))))]
fn trusted_parent(_path: &Path) -> Result<TrustedParent> {
    Err(containment_unavailable())
}

#[cfg(not(all(unix, any(feature = "caldav", feature = "lifetime"))))]
fn read_private_file(_path: &TrustedParent, _max_bytes: u64) -> Result<Vec<u8>> {
    Err(containment_unavailable())
}

#[cfg(not(all(unix, any(feature = "caldav", feature = "lifetime"))))]
fn load_optional_store(_path: &TrustedParent) -> Result<Option<StoredLease>> {
    Err(containment_unavailable())
}

#[cfg(not(all(unix, any(feature = "caldav", feature = "lifetime"))))]
fn write_store(_path: &TrustedParent, _store: &StoredLease) -> Result<()> {
    Err(containment_unavailable())
}

fn parse_store(bytes: &[u8]) -> Result<StoredLease> {
    let store: StoredLease = serde_json::from_slice(bytes)?;
    ensure!(store.schema == LEASE_SCHEMA, "unsupported Google lease store schema");
    ensure!(safe_account_ref(&store.account_ref), "Google lease account reference is malformed");
    ensure!(
        !store.access_token.is_empty()
            && store.access_token.len() <= MAX_TOKEN_BYTES
            && !store.access_token.chars().any(|c| c.is_control() || c.is_whitespace()),
        "stored Google access token is malformed"
    );
    if let Some(token) = &store.refresh_token {
        ensure!(
            !token.is_empty()
                && token.len() <= MAX_TOKEN_BYTES
                && !token.chars().any(|c| c.is_control() || c.is_whitespace()),
            "stored Google refresh token is malformed"
        );
    }
    ensure!(
        store.expires_at_ms > 0,
        "stored Google lease expiry must be a positive epoch millisecond value"
    );
    ensure!(!store.scopes.is_empty(), "stored Google lease lists no scopes");
    let mut scopes = BTreeSet::new();
    for value in &store.scopes {
        let scope = GoogleScope::parse(value)
            .ok_or_else(|| anyhow!("stored Google lease contains an unrecognized scope"))?;
        ensure!(scopes.insert(scope), "stored Google lease repeats a scope");
    }
    Ok(store)
}

fn expiry(expires_at_ms: i64) -> Result<SystemTime> {
    SystemTime::UNIX_EPOCH
        .checked_add(Duration::from_millis(expires_at_ms as u64))
        .ok_or_else(|| anyhow!("stored Google lease expiry is out of range"))
}

fn valid_account(store: &StoredLease, account_ref: &str) -> Result<()> {
    ensure!(
        store.account_ref == account_ref,
        "the configured Google lease belongs to a different account reference"
    );
    Ok(())
}

/// Host-selected production lease provider. The store path comes exclusively
/// from `GHOST_GOOGLE_TOKEN_STORE`; missing configuration is an explicit error,
/// never a fixture or anonymous fallback.
pub struct StoredTokenLeases {
    path: PathBuf,
    http: reqwest::Client,
}

impl StoredTokenLeases {
    pub fn from_env() -> Result<std::sync::Arc<dyn GoogleTokenLeaseProvider>> {
        Ok(std::sync::Arc::new(Self {
            path: stored_leases_path()?,
            http: oauth_http_client()?,
        }))
    }

    /// Read-only lease projection for status surfaces; no refresh and no writes.
    pub fn peek(&self, account_ref: &str) -> Result<StoredLeaseStatus> {
        Self::peek_env_at(&self.path, account_ref)
    }

    /// Read-only status projection against the environment-configured store.
    pub fn peek_env(account_ref: &str) -> Result<StoredLeaseStatus> {
        Self::peek_env_at(&stored_leases_path()?, account_ref)
    }

    fn peek_env_at(path: &Path, account_ref: &str) -> Result<StoredLeaseStatus> {
        ensure!(path.is_absolute(), "Google token store path must be absolute");
        let trusted = trusted_parent(path)?;
        let store = load_store(&trusted)?;
        valid_account(&store, account_ref)?;
        Ok(StoredLeaseStatus {
            account_ref: store.account_ref,
            scopes: store
                .scopes
                .iter()
                .map(|value| GoogleScope::parse(value).expect("store scopes are validated"))
                .collect(),
            expires_at: expiry(store.expires_at_ms)?,
            refreshable: store.refresh_token.is_some(),
        })
    }

    fn needs_refresh(store: &StoredLease) -> bool {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let skew = LEASE_CLOCK_SKEW.as_millis() as i64;
        store.expires_at_ms <= now.saturating_add(skew)
    }

    /// Snapshot the current durable lease under the lifecycle lock. The lock
    /// is released before any network I/O; the snapshot's generation is what
    /// every later commit is compared against.
    fn snapshot(&self) -> Result<(TrustedParent, LeaseSnapshot)> {
        ensure!(
            self.path.is_absolute(),
            "Google token store path must be absolute"
        );
        let trusted = trusted_parent(&self.path)?;
        let lock = lifecycle_lock(&trusted)?;
        let snapshot = lock
            .current(&trusted)?
            .ok_or_else(|| anyhow!("the Google lease store is missing; run planner-google login"))?;
        Ok((trusted, snapshot))
    }

    /// Exchange the durable refresh credential for a fresh access lease and
    /// commit it under the lifecycle lock's compare-and-swap. A refresh token
    /// returned by Google becomes the durable credential; the submitted one is
    /// retained only when Google omits a replacement. A store that changed in
    /// the meantime is never overwritten: the newer snapshot is used instead.
    /// A missing refresh token is an explicit re-provisioning requirement,
    /// never an anonymous fallback.
    async fn refresh(&self, account_ref: &str, required_scopes: &[GoogleScope]) -> Result<GoogleTokenLease> {
        let mut client = None;
        for _ in 0..REFRESH_CAS_ATTEMPTS {
            let (trusted, snapshot) = self.snapshot()?;
            valid_account(&snapshot.store, account_ref)?;
            ensure_granted(&snapshot.store, required_scopes)?;
            if !Self::needs_refresh(&snapshot.store) {
                // Another process refreshed or provisioned first; its lease is
                // the current one and must not be rolled back.
                return lease_from_store(snapshot.store);
            }
            let Some(refresh_token) = snapshot.store.refresh_token.clone() else {
                anyhow::bail!("the Google access lease is expired and no refresh token is stored; run planner-google login again");
            };
            if client.is_none() {
                client = Some(OAuthClient::from_env()?);
            }
            let client = client.as_ref().expect("OAuth client initialized for required exchange");
            let granted = self.exchange(&refresh_token, client).await?;
            granted.validate(Some(&stored_scopes(&snapshot.store)))?;
            let rotated = rotated_lease(&snapshot.store, &granted, refresh_token)?;
            let lock = lifecycle_lock(&trusted)?;
            match lock.commit(&trusted, &rotated, Some(&snapshot.generation)) {
                Ok(true) => return lease_from_store(rotated),
                Ok(false) => {} // superseded while exchanging; re-snapshot
                Err(error) => {
                    return Err(anyhow!(
                        "refreshed Google lease could not be stored atomically: {error}; if Google rotated the refresh credential, run planner-google login again"
                    ))
                }
            }
        }
        anyhow::bail!("the Google lease kept changing concurrently; retry the request")
    }

    async fn exchange(&self, refresh_token: &str, client: &OAuthClient) -> Result<TokenResponse> {
        let response = self
            .http
            .post(TOKEN_ORIGIN)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
                ("client_id", client.client_id.as_str()),
                ("client_secret", client.client_secret.as_str()),
            ])
            .send()
            .await
            .map_err(|_| anyhow!("Google token refresh request failed"))?;
        response
            .error_for_status()
            .map_err(|_| anyhow!("Google refused the token refresh; re-run planner-google login"))?
            .json()
            .await
            .map_err(|_| anyhow!("Google token refresh response is unreadable"))
    }
}

fn oauth_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .min_tls_version(reqwest::tls::Version::TLS_1_2)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .referer(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| anyhow!("Google OAuth HTTP client unavailable"))
}

impl GoogleTokenLeaseProvider for StoredTokenLeases {
    fn lease<'a>(
        &'a self,
        account_ref: &'a str,
        required_scopes: &'a [GoogleScope],
    ) -> GoogleTokenLeaseFuture<'a> {
        Box::pin(async move {
            ensure!(!required_scopes.is_empty(), "no Google scopes were requested");
            let (_trusted, snapshot) = self.snapshot()?;
            valid_account(&snapshot.store, account_ref)?;
            ensure_granted(&snapshot.store, required_scopes)?;
            if Self::needs_refresh(&snapshot.store) {
                return self.refresh(account_ref, required_scopes).await;
            }
            lease_from_store(snapshot.store)
        })
    }
}

fn stored_scopes(store: &StoredLease) -> BTreeSet<GoogleScope> {
    store
        .scopes
        .iter()
        .map(|value| GoogleScope::parse(value).expect("store scopes are validated"))
        .collect()
}

fn ensure_granted(store: &StoredLease, required_scopes: &[GoogleScope]) -> Result<()> {
    let granted = stored_scopes(store);
    for scope in required_scopes {
        let satisfied = granted.contains(scope)
            || scope
                .grants_storage()
                .is_some_and(|storage| granted.contains(&storage));
        ensure!(
            satisfied,
            "the stored Google lease lacks the required scope {}",
            scope.as_str()
        );
    }
    Ok(())
}

fn lease_from_store(store: StoredLease) -> Result<GoogleTokenLease> {
    let scopes = stored_scopes(&store).into_iter().collect::<Vec<_>>();
    Ok(GoogleTokenLease::new(
        store.account_ref,
        store.access_token,
        expiry(store.expires_at_ms)?,
        scopes,
    ))
}

/// The commit lease for a refresh exchange: a refresh token returned by
/// Google replaces the durable credential; the submitted one is kept only
/// when Google omits a replacement.
fn rotated_lease(
    store: &StoredLease,
    granted: &TokenResponse,
    submitted: String,
) -> Result<StoredLease> {
    Ok(StoredLease {
        schema: LEASE_SCHEMA.into(),
        account_ref: store.account_ref.clone(),
        access_token: granted.access_token.clone(),
        expires_at_ms: granted.expires_at_ms()?,
        scopes: store.scopes.clone(),
        refresh_token: Some(granted.refresh_token.clone().unwrap_or(submitted)),
    })
}

/// Hash of the exact durable lease content; the compare-and-swap token every
/// lifecycle commit and removal is validated against.
fn store_generation(store: &StoredLease) -> Result<String> {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(serde_json::to_vec(store)?);
    Ok(format!("{:x}", digest))
}

struct LeaseSnapshot {
    store: StoredLease,
    generation: String,
}

/// Exclusive cross-process lifecycle lock for one lease store. Host refresh
/// and CLI login/revoke share this protocol, so commits and removals are
/// serialized machine-wide. The lock file is created and validated relative
/// to the pinned parent descriptor (private, singly linked, owner-checked,
/// ACL-checked) and re-verified against its directory entry before each
/// attempt, so a replaced entry can never silently split the protocol.
#[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
struct LifecycleLock {
    _guard: File,
    file_name: std::ffi::CString,
}

#[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
fn lock_entry_matches(path: &TrustedParent, guard: &File, name: &std::ffi::CString) -> Result<bool> {
    use std::os::fd::AsRawFd;
    check_private_file_handle(guard, "lease lifecycle lock", MAX_STORE_BYTES)?;
    let mut entry: libc::stat = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::fstatat(path.directory.as_raw_fd(), name.as_ptr(), &mut entry, libc::AT_SYMLINK_NOFOLLOW)
    };
    let opened = guard.metadata()?;
    Ok(result == 0 && entry.st_dev as u64 == opened.dev() && entry.st_ino == opened.ino())
}

#[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
fn lifecycle_lock(path: &TrustedParent) -> Result<LifecycleLock> {
    use fs2::FileExt;
    use std::os::fd::{AsRawFd, FromRawFd};
    let lock_name = std::ffi::CString::new(format!(
        "{}.lock",
        path.file_name.to_string_lossy()
    ))
    .expect("lock file name has no NUL");
    for _ in 0..LOCK_ATTEMPTS {
        let descriptor = unsafe {
            libc::openat(
                path.directory.as_raw_fd(),
                lock_name.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if descriptor < 0 {
            // Symlinked or otherwise hostile lock entries fail here; retry
            // against whichever entry survives at the lock name.
            continue;
        }
        let guard = unsafe { File::from_raw_fd(descriptor) };
        check_private_file_handle(&guard, "lease lifecycle lock", MAX_STORE_BYTES)?;
        if !lock_entry_matches(path, &guard, &lock_name)? {
            continue;
        }
        guard
            .lock_exclusive()
            .map_err(|error| anyhow!("lease lifecycle lock is unavailable: {error}"))?;
        if !lock_entry_matches(path, &guard, &lock_name)? {
            continue;
        }
        return Ok(LifecycleLock { _guard: guard, file_name: lock_name });
    }
    bail!("lease lifecycle lock could not be established")
}

#[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
impl LifecycleLock {
    fn validate(&self, path: &TrustedParent) -> Result<()> {
        ensure!(lock_entry_matches(path, &self._guard, &self.file_name)?,
            "lease lifecycle lock entry changed; operation refused");
        Ok(())
    }

    /// Current durable lease; `None` when the store does not exist yet.
    fn current(&self, path: &TrustedParent) -> Result<Option<LeaseSnapshot>> {
        self.validate(path)?;
        match load_optional_store(path)? {
            Some(store) => Ok(Some(LeaseSnapshot {
                generation: store_generation(&store)?,
                store,
            })),
            None => Ok(None),
        }
    }

    /// Compare-and-swap commit. `None` expects an absent store, so first
    /// provisioning is no-clobber; `Some` expects the exact snapshot
    /// generation, so a stale or replaced lease is never overwritten.
    /// Returns `false` when the store did not match and nothing was written.
    fn commit(
        &self,
        path: &TrustedParent,
        store: &StoredLease,
        expected: Option<&str>,
    ) -> Result<bool> {
        let actual = self.current(path)?;
        let actual = actual.as_ref().map(|snapshot| snapshot.generation.as_str());
        if actual != expected {
            return Ok(false);
        }
        self.validate(path)?;
        write_store(path, store)?;
        Ok(true)
    }

    /// Remove the store only while it still holds the grant that was just
    /// revoked: matched by the durable refresh credential, or by the access
    /// token when no refresh credential exists. A store provisioned or
    /// rotated meanwhile is kept, and the removal is synced to the pinned
    /// parent directory before success is reported.
    fn remove_revoked(
        &self,
        path: &TrustedParent,
        refresh_token: Option<&str>,
        access_token: &str,
    ) -> Result<bool> {
        use std::os::fd::AsRawFd;
        let Some(snapshot) = self.current(path)? else {
            return Ok(true); // already gone; the grant was revoked
        };
        let same_grant = match (refresh_token, snapshot.store.refresh_token.as_deref()) {
            (Some(expected), Some(actual)) => expected == actual,
            (Some(_), None) | (None, Some(_)) => false,
            (None, None) => snapshot.store.access_token == access_token,
        };
        if !same_grant {
            return Ok(false);
        }
        self.validate(path)?;
        let removed = unsafe {
            libc::unlinkat(path.directory.as_raw_fd(), path.file_name.as_ptr(), 0)
        };
        ensure!(
            removed == 0,
            "credential store could not be removed: {}",
            std::io::Error::last_os_error()
        );
        // Durable removal: the unlinked entry must stay gone across crashes.
        path.directory.sync_all()?;
        Ok(true)
    }
}

#[cfg(not(all(unix, any(feature = "caldav", feature = "lifetime"))))]
struct LifecycleLock {
    _unavailable: (),
}

#[cfg(not(all(unix, any(feature = "caldav", feature = "lifetime"))))]
fn lifecycle_lock(_path: &TrustedParent) -> Result<LifecycleLock> {
    Err(containment_unavailable())
}

#[cfg(not(all(unix, any(feature = "caldav", feature = "lifetime"))))]
impl LifecycleLock {
    fn current(&self, _path: &TrustedParent) -> Result<Option<LeaseSnapshot>> {
        Err(containment_unavailable())
    }

    fn commit(
        &self,
        _path: &TrustedParent,
        _store: &StoredLease,
        _expected: Option<&str>,
    ) -> Result<bool> {
        Err(containment_unavailable())
    }

    fn remove_revoked(
        &self,
        _path: &TrustedParent,
        _refresh_token: Option<&str>,
        _access_token: &str,
    ) -> Result<bool> {
        Err(containment_unavailable())
    }
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    #[serde(default)]
    expires_in: Option<serde_json::Value>,
    #[serde(default)]
    refresh_token: Option<String>,
    scope: String,
}

impl TokenResponse {
    fn expires_at_ms(&self) -> Result<i64> {
        let seconds = match self.expires_in.as_ref() {
            Some(value) => value
                .as_u64()
                .ok_or_else(|| anyhow!("Google token expiry is malformed"))?,
            None => anyhow::bail!("Google token response has no expiry"),
        };
        ensure!(
            (1..=24 * 60 * 60).contains(&seconds),
            "Google token expiry is outside the accepted range"
        );
        let now: i64 = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .map_err(|_| anyhow!("system clock is before the epoch"))?;
        Ok(now + i64::try_from(seconds)? * 1_000)
    }

    fn validate(&self, required: Option<&BTreeSet<GoogleScope>>) -> Result<()> {
        ensure!(
            self.token_type.eq_ignore_ascii_case("bearer"),
            "Google returned an unsupported token type"
        );
        ensure!(
            !self.access_token.is_empty()
                && self.access_token.len() <= MAX_TOKEN_BYTES
                && !self.access_token.chars().any(|c| c.is_control() || c.is_whitespace()),
            "Google access token is malformed"
        );
        if let Some(refresh_token) = &self.refresh_token {
            ensure!(
                !refresh_token.is_empty()
                    && refresh_token.len() <= MAX_TOKEN_BYTES
                    && !refresh_token.chars().any(|c| c.is_control() || c.is_whitespace()),
                "Google refresh token is malformed"
            );
        }
        let mut granted = BTreeSet::new();
        for value in self.scope.split_whitespace() {
            let scope = GoogleScope::parse(value)
                .ok_or_else(|| anyhow!("Google granted an unrecognized scope; re-run planner-google login with the intended scopes"))?;
            granted.insert(scope);
        }
        if let Some(required) = required {
            for scope in required {
                ensure!(
                    granted.contains(scope),
                    "Google did not grant the requested scope {}",
                    scope.as_str()
                );
            }
        }
        Ok(())
    }
}

/// Owner-configured installed-app OAuth client. Credentials live in one
/// private file; they are never accepted from prompts or environment values.
pub struct OAuthClient {
    pub client_id: String,
    client_secret: String,
}

impl OAuthClient {
    pub fn from_env() -> Result<Self> {
        let path = std::env::var_os(OAUTH_CLIENT_ENV).ok_or_else(|| {
            anyhow!("explicit Google OAuth client is not configured ({OAUTH_CLIENT_ENV})")
        })?;
        let path = PathBuf::from(path);
        ensure!(path.is_absolute(), "Google OAuth client path must be absolute");
        let trusted = trusted_parent(&path)?;
        let value: serde_json::Value =
            serde_json::from_slice(&read_private_file(&trusted, MAX_CLIENT_BYTES)?)?;
        ensure!(
            value["schema"] == CLIENT_SCHEMA,
            "unsupported Google OAuth client schema"
        );
        let client_id = value["client_id"]
            .as_str()
            .ok_or_else(|| anyhow!("Google OAuth client_id is missing"))?;
        let client_secret = value["client_secret"]
            .as_str()
            .ok_or_else(|| anyhow!("Google OAuth client_secret is missing"))?;
        let safe = |value: &str| {
            !value.is_empty()
                && value.len() <= 512
                && !value.chars().any(|c| c.is_control() || c.is_whitespace())
        };
        ensure!(safe(client_id) && safe(client_secret), "Google OAuth client credentials are malformed");
        Ok(Self {
            client_id: client_id.into(),
            client_secret: client_secret.into(),
        })
    }
}

fn pkce_pair() -> (String, String) {
    // 4 UUIDv4 values give 256 hex characters of verifier entropy; S256 keeps
    // the verifier local until the code exchange.
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let verifier: String = (0..4)
        .map(|_| uuid::Uuid::new_v4().simple().to_string())
        .collect();
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

/// Provision one account's durable lease through the installed-app flow with
/// PKCE and a loopback redirect. The user completes consent in their own
/// browser; this process never sees or stores the password and prints no token.
pub async fn provision(
    account_ref: &str,
    scopes: &[GoogleScope],
    port: u16,
    replace: bool,
) -> Result<StoredLeaseStatus> {
    ensure!(safe_account_ref(account_ref), "account reference must be a short opaque label without whitespace");
    ensure!(!scopes.is_empty(), "request at least one Google scope");
    let unique: BTreeSet<_> = scopes.iter().copied().collect();
    ensure!(unique.len() == scopes.len(), "duplicate requested scopes");
    let client = OAuthClient::from_env()?;
    let store_path = stored_leases_path()?;
    if let Some(parent) = store_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Advisory pre-flight only; the authoritative no-clobber / --replace
    // decision is re-made under the lifecycle lock after consent, so two
    // concurrent logins can never bypass --replace or overwrite another
    // account's store.
    {
        let trusted = trusted_parent(&store_path)?;
        if let Some(existing) = load_optional_store(&trusted)? {
            ensure!(
                replace && existing.account_ref == account_ref,
                "a Google lease store already exists; re-provisioning requires --replace for the same account reference"
            );
        }
    }
    let (verifier, challenge) = pkce_pair();
    let state = uuid::Uuid::new_v4().simple().to_string();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let bound_port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{bound_port}/");
    let scope_param = scopes
        .iter()
        .map(|scope| scope.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let query = [
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("response_type", "code"),
        ("scope", scope_param.as_str()),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent"),
    ];
    let auth_url = reqwest::Url::parse_with_params(AUTH_ORIGIN, &query)?;
    println!("1. Open this URL and approve the requested scopes:");
    println!("{auth_url}");
    println!("2. Waiting for the loopback redirect on {redirect_uri} ...");
    // The expected state is enforced inside the listener; only an
    // authenticated authorization code comes back.
    let code = wait_for_redirect(listener, &state).await?;
    let http = oauth_http_client()?;
    let response = http
        .post(TOKEN_ORIGIN)
        .form(&[
            ("code", code.as_str()),
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|_| anyhow!("Google token exchange request failed"))?;
    let tokens: TokenResponse = response
        .error_for_status()
        .map_err(|_| anyhow!("Google refused the authorization code exchange"))?
        .json()
        .await
        .map_err(|_| anyhow!("Google token response is unreadable"))?;
    let requested = unique;
    tokens.validate(Some(&requested))?;
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| anyhow!("Google returned no offline refresh token; restart provisioning"))?;
    let store = StoredLease {
        schema: LEASE_SCHEMA.into(),
        account_ref: account_ref.into(),
        access_token: tokens.access_token.clone(),
        expires_at_ms: tokens.expires_at_ms()?,
        scopes: requested.iter().map(|scope| scope.as_str().to_owned()).collect(),
        refresh_token: Some(refresh_token),
    };
    let trusted = trusted_parent(&store_path)?;
    let lock = lifecycle_lock(&trusted)?;
    let committed = match lock.current(&trusted)? {
        None => lock.commit(&trusted, &store, None)?,
        Some(snapshot) => {
            ensure!(
                replace && snapshot.store.account_ref == account_ref,
                "a Google lease store already exists; re-provisioning requires --replace for the same account reference"
            );
            lock.commit(&trusted, &store, Some(&snapshot.generation))?
        }
    };
    ensure!(
        committed,
        "a Google lease store appeared while consent was in progress; restart planner-google login (--replace applies to the same account reference only)"
    );
    Ok(StoredLeaseStatus {
        account_ref: account_ref.into(),
        scopes: requested,
        expires_at: expiry(store.expires_at_ms)?,
        refreshable: true,
    })
}

/// Receive the loopback OAuth callback. The expected state is enforced inside
/// the listener for both success and denial; wrong-state, malformed or
/// ambiguous traffic is answered with a neutral page and ignored until the
/// absolute consent deadline. Only an authenticated authorization code is
/// returned.
async fn wait_for_redirect(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> Result<String> {
    wait_for_redirect_until(listener, expected_state, CONSENT_DEADLINE).await
}

async fn wait_for_redirect_until(
    listener: tokio::net::TcpListener,
    expected_state: &str,
    consent: Duration,
) -> Result<String> {
    let deadline = tokio::time::Instant::now() + consent;
    loop {
        let accepted = tokio::time::timeout_at(deadline, listener.accept()).await;
        let (mut stream, _) = match accepted {
            Ok(accepted) => accepted?,
            Err(_) => bail!("timed out waiting for the OAuth loopback redirect"),
        };
        if let Some(result) = handle_redirect(&mut stream, expected_state, deadline).await {
            return result;
        }
    }
}

/// What one callback request means after validation.
enum CallbackVerdict {
    /// Authenticated success: the state matched and a bounded code was sent.
    Code(String),
    /// Authenticated denial: the state matched and Google's error is one of
    /// the known codes; the raw query text is never echoed anywhere.
    Denied(&'static str),
    /// Wrong state, missing state, wrong method or path, ambiguous or
    /// malformed input: answer neutrally and keep listening.
    Noise,
}

/// Handle one accepted connection inside an absolute per-request bound that
/// never exceeds the consent deadline. Reading, classifying and writing the
/// response all happen inside that bound, so a trickling or stalled peer
/// cannot extend consent.
async fn handle_redirect(
    stream: &mut tokio::net::TcpStream,
    expected_state: &str,
    consent_deadline: tokio::time::Instant,
) -> Option<Result<String>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let request_deadline = consent_deadline.min(tokio::time::Instant::now() + REQUEST_DEADLINE);
    let verdict = match tokio::time::timeout_at(request_deadline, async {
        // Bounded header read; incomplete or oversized requests are refused
        // instead of being parsed from truncated bytes.
        let mut bytes = Vec::<u8>::new();
        let mut chunk = [0u8; 1024];
        let complete = loop {
            match stream.read(&mut chunk).await {
                Ok(0) => break false,
                Ok(n) => {
                    bytes.extend_from_slice(&chunk[..n]);
                    if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                        break true;
                    }
                    if bytes.len() > MAX_REQUEST_BYTES {
                        break false;
                    }
                }
                Err(_) => break false,
            }
        };
        if !complete {
            return None;
        }
        let verdict =
            classify_callback(std::str::from_utf8(&bytes).ok()?, expected_state)?;
        // Build the complete page first so Content-Length always declares the
        // exact transmitted body.
        let body = match &verdict {
            CallbackVerdict::Code(_) => "승인되었습니다. 이 창을 닫아도 됩니다.",
            CallbackVerdict::Denied(_) => {
                "승인이 완료되지 않았습니다. 창을 닫고 다시 시도해 주세요."
            }
            CallbackVerdict::Noise => "잘못된 요청입니다.",
        };
        let page =
            format!("<!doctype html><meta charset=\"utf-8\"><title>Ghost planner</title><p>{body}</p>");
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
            page.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.flush().await;
        Some(verdict)
    })
    .await
    {
        Ok(Some(verdict)) => verdict,
        Ok(None) | Err(_) => return None, // noise, stall or request-bound expiry
    };
    match verdict {
        CallbackVerdict::Code(code) => Some(Ok(code)),
        CallbackVerdict::Denied(reason) => Some(Err(anyhow!(
            "Google OAuth consent was not completed: {reason}"
        ))),
        CallbackVerdict::Noise => None,
    }
}

/// Classify one callback request. Both success and denial are terminal only
/// when the exact expected state is present; everything else is noise.
fn classify_callback(request: &str, expected_state: &str) -> Option<CallbackVerdict> {
    let request_line = request.lines().next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    if method != "GET" {
        return Some(CallbackVerdict::Noise);
    }
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/" {
        return Some(CallbackVerdict::Noise);
    }
    let mut error = None;
    let mut code = None;
    let mut state = None;
    let mut ambiguous = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            // Unknown parameters (Google adds e.g. scope) are ignored, but a
            // repeated parameter of the ones below is ambiguous input.
            "error" => ambiguous |= error.replace(value.into_owned()).is_some(),
            "code" => ambiguous |= code.replace(value.into_owned()).is_some(),
            "state" => ambiguous |= state.replace(value.into_owned()).is_some(),
            _ => {}
        }
    }
    if ambiguous || state.as_deref() != Some(expected_state) {
        return Some(CallbackVerdict::Noise);
    }
    if let Some(error_value) = error {
        if code.is_some() {
            return Some(CallbackVerdict::Noise);
        }
        // Allowlisted, fixed diagnostic strings only; the raw query value is
        // never placed into errors or the response page.
        let reason = match error_value.as_str() {
            "access_denied" => "the owner denied consent",
            "admin_policy_enforced" => "a Google Workspace policy blocked this client",
            "internal_error" | "server_error" => "Google reported a server error",
            "invalid_request" => "Google rejected the consent request",
            "redirect_uri_mismatch" => "the redirect did not match the registered client",
            "temporarily_unavailable" => "Google is temporarily unavailable",
            _ => "consent returned an unrecognized error",
        };
        return Some(CallbackVerdict::Denied(reason));
    }
    let code = code?;
    if code.is_empty()
        || code.len() > MAX_TOKEN_BYTES
        || code.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Some(CallbackVerdict::Noise);
    }
    Some(CallbackVerdict::Code(code))
}

/// Revoke the durable lease at Google's fixed revocation endpoint, then
/// durably remove exactly the revoked generation under the lifecycle lock.
/// The refresh credential is revoked when present; the access token is
/// submitted only for non-refreshable leases. Unknown outcomes keep the file.
pub async fn revoke() -> Result<()> {
    let store_path = stored_leases_path()?;
    let trusted = trusted_parent(&store_path)?;
    let snapshot = {
        let lock = lifecycle_lock(&trusted)?;
        lock.current(&trusted)?
            .ok_or_else(|| anyhow!("no Google lease store is configured; nothing to revoke"))?
    };
    let revoked_refresh = snapshot.store.refresh_token.as_deref();
    let credential = revoked_refresh.unwrap_or(&snapshot.store.access_token);
    let http = oauth_http_client()?;
    let response = http
        .post(REVOKE_ORIGIN)
        .form(&[("token", credential)])
        .send()
        .await;
    let mut reply = match response {
        Ok(reply) => reply,
        Err(_) => bail!(
            "revocation outcome is unknown (network unavailable); the token store is retained"
        ),
    };
    let status = reply.status();
    let confirmed_invalid = if status == reqwest::StatusCode::BAD_REQUEST {
        let mut body = Vec::new();
        while let Some(chunk) = reply.chunk().await.map_err(|_| {
            anyhow!("revocation response is incomplete; the token store is retained")
        })? {
            ensure!(body.len() + chunk.len() <= MAX_REQUEST_BYTES,
                "revocation response exceeds its limit; the token store is retained");
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|value| value.get("error").and_then(Value::as_str).map(|code| code == "invalid_token"))
            == Some(true)
    } else {
        false
    };
    ensure!(
        status == reqwest::StatusCode::OK || confirmed_invalid,
        "Google did not confirm revocation (HTTP {status}); the token store is retained"
    );
    let lock = lifecycle_lock(&trusted)?;
    let removed =
        lock.remove_revoked(&trusted, revoked_refresh, &snapshot.store.access_token)?;
    if !removed {
        println!(
            "Google lease revoked; a different grant replaced the store during revocation, so the current file is retained."
        );
    } else if confirmed_invalid {
        println!("Google confirmed the submitted credential is invalid; its lease store was removed.");
    } else {
        println!("Google lease revoked and the token store removed.");
    }
    Ok(())
}

/// Token-free status of the configured store for owner surfaces.
pub fn status() -> Result<Value> {
    let path = stored_leases_path()?;
    let trusted = trusted_parent(&path)?;
    let store = load_store(&trusted)?;
    let scopes: Vec<&str> = store.scopes.iter().map(String::as_str).collect();
    Ok(serde_json::json!({
        "store": path,
        "account_ref": store.account_ref,
        "scopes": scopes,
        "expires_at_ms": store.expires_at_ms,
        "refreshable": store.refresh_token.is_some(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: Option<std::ffi::OsString>) -> Self {
            let lock = ENV_LOCK.lock().unwrap();
            let previous = vec![(key, std::env::var_os(key))];
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
            Self { previous, _lock: lock }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.previous {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    fn store_json(expires_in_seconds: i64, scopes: &[&str], refresh: bool) -> String {
        format!(
            r#"{{"schema":"ghost-google-lease/1","account_ref":"personal","access_token":"tok","expires_at_ms":{},"scopes":{},"refresh_token":{}}}"#,
            now_ms() + expires_in_seconds * 1000,
            serde_json::to_string(scopes).unwrap(),
            if refresh { "\"r\"" } else { "null" }
        )
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    fn write_store_fixture(dir: &Path, body: &str, mode_readonly: bool) -> PathBuf {
        let path = dir.join("google-lease.json");
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                &path,
                std::fs::Permissions::from_mode(if mode_readonly { 0o644 } else { 0o600 }),
            )
            .unwrap();
        }
        path
    }

    #[test]
    fn scope_parsing_is_exact_and_unknown_scopes_are_refused() {
        for scope in [
            GoogleScope::CalendarEventsReadOnly,
            GoogleScope::CalendarEvents,
            GoogleScope::TasksReadOnly,
            GoogleScope::Tasks,
        ] {
            assert_eq!(GoogleScope::parse(scope.as_str()), Some(scope));
        }
        assert_eq!(GoogleScope::parse("https://www.googleapis.com/auth/calendar"), None);
        assert_eq!(GoogleScope::parse("https://www.googleapis.com/auth/calendar.readonly"), None);
    }

    #[tokio::test]
    async fn missing_store_env_is_an_explicit_error() {
        let _guard = EnvGuard::set(TOKEN_STORE_ENV, None);
        let error = StoredTokenLeases::from_env().err().unwrap().to_string();
        assert!(error.contains(TOKEN_STORE_ENV), "{error}");
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[tokio::test]
    async fn lease_requires_exact_account_and_requested_scopes() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = EnvGuard::set(
            TOKEN_STORE_ENV,
            Some(
                write_store_fixture(
                    dir.path(),
                    &store_json(3600, &["https://www.googleapis.com/auth/calendar.events.readonly"], true),
                    false,
                )
                .into_os_string(),
            ),
        );
        let leases = StoredTokenLeases::from_env().unwrap();
        let wrong_account = leases
            .lease("other", &[GoogleScope::CalendarEventsReadOnly])
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(wrong_account.contains("different account reference"), "{wrong_account}");
        let missing_scope = leases
            .lease("personal", &[GoogleScope::TasksReadOnly])
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(missing_scope.contains("lacks the required scope"), "{missing_scope}");
        let lease = leases
            .lease("personal", &[GoogleScope::CalendarEventsReadOnly])
            .await
            .unwrap();
        assert_eq!(lease.account_ref(), "personal");
        assert!(lease.grants(GoogleScope::CalendarEventsReadOnly));
        assert!(!lease.grants(GoogleScope::CalendarEvents));
        let status = StoredTokenLeases::peek_env("personal").unwrap();
        assert!(status.refreshable);
    }


    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[tokio::test]
    async fn group_readable_store_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = EnvGuard::set(
            TOKEN_STORE_ENV,
            Some(
                write_store_fixture(
                    dir.path(),
                    &store_json(3600, &["https://www.googleapis.com/auth/tasks.readonly"], true),
                    true,
                )
                .into_os_string(),
            ),
        );
        let leases = StoredTokenLeases::from_env().unwrap();
        let error = leases
            .lease("personal", &[GoogleScope::TasksReadOnly])
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("chmod 600"), "{error}");
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn malformed_stores_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let load_fixture = |path: &Path| {
            let trusted = trusted_parent(path)?;
            load_store(&trusted)
        };
        let cases = [
            store_json(3600, &["https://www.googleapis.com/auth/calendar"], true),
            store_json(3600, &["https://www.googleapis.com/auth/tasks.readonly", "https://www.googleapis.com/auth/tasks.readonly"], true),
            format!(r#"{{"schema":"ghost-google-lease/1","account_ref":"a b","access_token":"t","expires_at_ms":1,"scopes":["https://www.googleapis.com/auth/tasks.readonly"]}}"#),
            // An expired-but-positive epoch is structurally valid; zero is not.
            r#"{"schema":"ghost-google-lease/1","account_ref":"personal","access_token":"tok","expires_at_ms":0,"scopes":["https://www.googleapis.com/auth/tasks.readonly"],"refresh_token":"r"}"#.to_string(),
        ];
        for body in cases {
            let path = write_store_fixture(dir.path(), &body, false);
            assert!(load_fixture(&path).is_err(), "{body}");
        }
    }

    #[test]
    fn token_response_validates_type_expiry_and_granted_scopes() {
        let response = TokenResponse {
            access_token: "t".into(),
            token_type: "Bearer".into(),
            expires_in: Some(serde_json::json!(3600)),
            refresh_token: Some("r".into()),
            scope: "https://www.googleapis.com/auth/calendar.events.readonly".into(),
        };
        let mut required = BTreeSet::new();
        required.insert(GoogleScope::CalendarEventsReadOnly);
        assert!(response.validate(Some(&required)).is_ok());
        required.insert(GoogleScope::CalendarEvents);
        let error = response.validate(Some(&required)).err().unwrap().to_string();
        assert!(error.contains("did not grant"), "{error}");
        let wrong_type = TokenResponse {
            token_type: "mac".into(),
            ..response
        };
        assert!(wrong_type.validate(None).is_err());
    }

    async fn send_callback(port: u16, request: impl AsRef<str>) -> Vec<u8> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_ref().as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        response
    }

    fn get(target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    }

    #[tokio::test]
    async fn callback_requires_expected_state_inside_the_listener() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let wrong_state = send_callback(port, get("/?code=nope&state=wrong"));
        let valid = send_callback(port, get("/?code=abc&state=expected"));
        let (result, _) = tokio::join!(
            wait_for_redirect_until(listener, "expected", Duration::from_secs(10)),
            async {
                wrong_state.await;
                valid.await
            }
        );
        assert_eq!(result.unwrap(), "abc");
    }

    #[tokio::test]
    async fn authenticated_denial_is_terminal_with_bounded_diagnostics() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = send_callback(port, get("/?error=access_denied&state=st"));
        let (result, _) = tokio::join!(
            wait_for_redirect_until(listener, "st", Duration::from_secs(10)),
            client
        );
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn denial_error_text_is_never_echoed_and_wrong_state_denial_is_noise() {
        // A denial without the expected state must not terminate consent.
        {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let forged = send_callback(port, get("/?error=access_denied%0A%0B&state=forged"));
            let valid = send_callback(port, get("/?code=late&state=st"));
            let (result, _) = tokio::join!(
                wait_for_redirect_until(listener, "st", Duration::from_secs(10)),
                async {
                    forged.await;
                    valid.await
                }
            );
            assert_eq!(result.unwrap(), "late");
        }
        // An authenticated unknown error stays bounded: the raw percent-decoded
        // query text and its control characters never reach the terminal.
        {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let client = send_callback(port, get("/?error=%3Cscript%3E%0Aline&state=st"));
            let (result, page) = tokio::join!(
                wait_for_redirect_until(listener, "st", Duration::from_secs(10)),
                client
            );
            let message = result.err().unwrap().to_string();
            assert!(!message.contains("script"), "{message}");
            assert!(!message.contains("line"), "{message}");
            let page = String::from_utf8(page).unwrap();
            assert!(!page.contains("script"));
        }
    }

    #[tokio::test]
    async fn callback_ignores_wrong_methods_paths_and_ambiguous_queries() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let post = send_callback(port, "POST /?code=c&state=st HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        let favicon = send_callback(port, get("/favicon.ico"));
        let duplicate = send_callback(port, get("/?code=a&code=b&state=st"));
        let valid = send_callback(port, get("/?code=ok&state=st"));
        let (result, _) = tokio::join!(
            wait_for_redirect_until(listener, "st", Duration::from_secs(10)),
            async {
                post.await;
                favicon.await;
                duplicate.await;
                valid.await
            }
        );
        assert_eq!(result.unwrap(), "ok");
    }

    #[tokio::test]
    async fn callback_response_declares_the_full_body_length() {
        for target in ["/?code=abc&state=st", "/?error=access_denied&state=st", "/favicon.ico"] {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let client = send_callback(port, get(target));
            // The response is written as soon as the request is classified;
            // noise never terminates the listener, so its bound stays short
            // and the deadline error is ignored on purpose.
            let (_, response) = tokio::join!(
                async {
                    let _ =
                        wait_for_redirect_until(listener, "st", Duration::from_secs(1)).await;
                },
                client
            );
            let response = String::from_utf8(response).unwrap();
            let (head, body) = response.split_once("\r\n\r\n").unwrap();
            assert!(head.starts_with("HTTP/1.1 200 OK"));
            let declared: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .expect("Content-Length present")
                .parse()
                .unwrap();
            assert_eq!(
                declared,
                body.len(),
                "declared length must equal the transmitted body for {target}"
            );
        }
    }

    #[tokio::test]
    async fn trickling_peer_cannot_extend_the_consent_deadline() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let trickler = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            if let Ok(mut stream) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                // Never completes a header block and stays under the byte cap,
                // while dribbling past the one-second consent deadline.
                for _ in 0..12 {
                    if stream.write_all(b"GET /?trickle=1").await.is_err() {
                        break;
                    }
                    let _ = stream.flush().await;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        });
        let started = std::time::Instant::now();
        let error = wait_for_redirect_until(listener, "st", Duration::from_secs(1))
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("timed out"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the consent deadline did not stay absolute: {:?}",
            started.elapsed()
        );
        trickler.abort();
    }

    #[tokio::test]
    async fn stalled_connection_cannot_monopolize_consent() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let stalled = tokio::spawn(async move {
            let _stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let started = std::time::Instant::now();
        let error = wait_for_redirect_until(listener, "st", Duration::from_secs(1))
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(4));
        stalled.abort();
    }

    #[test]
    fn token_response_requires_a_usable_expiry() {
        let response = TokenResponse {
            access_token: "t".into(),
            token_type: "Bearer".into(),
            expires_in: None,
            refresh_token: None,
            scope: "https://www.googleapis.com/auth/tasks.readonly".into(),
        };
        assert!(response.expires_at_ms().is_err());
        let malformed = TokenResponse {
            expires_in: Some(serde_json::json!("soon")),
            ..response
        };
        assert!(malformed.expires_at_ms().is_err());
    }

    #[test]
    fn pkce_pair_is_deterministically_shaped() {
        let (verifier, challenge) = pkce_pair();
        // RFC 7636 allows 43..=128 verifier characters; 4 UUIDv4 simple forms
        // give exactly 128 hex characters of entropy.
        assert_eq!(verifier.len(), 128);
        assert!(verifier.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!challenge.is_empty() && !challenge.contains('=') && !challenge.contains('+'));
        assert_ne!(verifier, pkce_pair().0);
    }

    fn tasks_store(account: &str, refresh: Option<&str>, expires_in_seconds: i64) -> StoredLease {
        StoredLease {
            schema: LEASE_SCHEMA.into(),
            account_ref: account.into(),
            access_token: "a".into(),
            expires_at_ms: now_ms() + expires_in_seconds * 1000,
            scopes: vec![GoogleScope::TasksReadOnly.as_str().to_owned()],
            refresh_token: refresh.map(str::to_owned),
        }
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    fn fixture_location(dir: &Path) -> TrustedParent {
        trusted_parent(&dir.join("google-lease.json")).unwrap()
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn absent_store_reads_as_none_but_hostile_entries_fail() {
        let dir = tempfile::tempdir().unwrap();
        let trusted = fixture_location(dir.path());
        assert!(load_optional_store(&trusted).unwrap().is_none());
        // A group-readable entry fails validation instead of looking absent.
        std::fs::write(dir.path().join("google-lease.json"), "junk").unwrap();
        assert!(load_optional_store(&trusted).is_err());
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn symlinked_store_entries_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.json");
        std::fs::write(
            &real,
            store_json(3600, &["https://www.googleapis.com/auth/tasks.readonly"], true),
        )
        .unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("link.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let trusted = trusted_parent(&link).unwrap();
        assert!(load_store(&trusted).is_err());
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn group_writable_ancestors_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        std::fs::set_permissions(&nested, std::fs::Permissions::from_mode(0o730)).unwrap();
        let error = trusted_parent(&nested.join("store.json"))
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("group- or other-writable"), "{error}");
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn hard_linked_and_oversized_stores_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-lease.json");
        let trusted = fixture_location(dir.path());
        std::fs::write(
            &path,
            store_json(3600, &["https://www.googleapis.com/auth/tasks.readonly"], true),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::hard_link(&path, dir.path().join("alias.json")).unwrap();
        let error = load_store(&trusted).err().unwrap().to_string();
        assert!(error.contains("hard-linked"), "{error}");
        std::fs::remove_file(dir.path().join("alias.json")).unwrap();
        let oversized = "x".repeat(MAX_STORE_BYTES as usize + 1);
        std::fs::write(&path, oversized).unwrap();
        assert!(load_store(&trusted).is_err());
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn commit_is_no_clobber_then_generation_cas() {
        let dir = tempfile::tempdir().unwrap();
        let trusted = fixture_location(dir.path());
        let lock = lifecycle_lock(&trusted).unwrap();
        // First creation commits without an existing store...
        assert!(lock
            .commit(&trusted, &tasks_store("personal", Some("r1"), 3600), None)
            .unwrap());
        let generation = lock.current(&trusted).unwrap().unwrap().generation;
        // ...and stays no-clobber: a second absent-expectation commit is refused.
        assert!(!lock
            .commit(&trusted, &tasks_store("personal", Some("r2"), 3600), None)
            .unwrap());
        assert_eq!(
            lock.current(&trusted).unwrap().unwrap().store.refresh_token.as_deref(),
            Some("r1")
        );
        // The matching generation commits; a stale generation never overwrites.
        assert!(lock
            .commit(&trusted, &tasks_store("personal", Some("r2"), 3600), Some(&generation))
            .unwrap());
        let newer = lock.current(&trusted).unwrap().unwrap().generation;
        assert_ne!(generation, newer);
        assert!(!lock
            .commit(&trusted, &tasks_store("personal", Some("r3"), 3600), Some(&generation))
            .unwrap());
        assert_eq!(
            lock.current(&trusted).unwrap().unwrap().store.refresh_token.as_deref(),
            Some("r2")
        );
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn concurrent_first_provisions_have_exactly_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-lease.json");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let accounts = ["alpha", "beta"];
        let handles: Vec<_> = accounts
            .map(|account| {
                let barrier = barrier.clone();
                let path = path.clone();
                std::thread::spawn(move || {
                    let trusted = trusted_parent(&path).unwrap();
                    barrier.wait();
                    let lock = lifecycle_lock(&trusted).unwrap();
                    lock.commit(&trusted, &tasks_store(account, Some("r"), 3600), None)
                        .unwrap()
                })
            })
            .into_iter()
            .collect();
        let winners = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|committed| *committed)
            .count();
        assert_eq!(winners, 1, "no-clobber must keep exactly one first login");
        let trusted = fixture_location(dir.path());
        let lock = lifecycle_lock(&trusted).unwrap();
        let current = lock.current(&trusted).unwrap().unwrap();
        assert!(current.store.account_ref == "alpha" || current.store.account_ref == "beta");
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn removal_only_deletes_the_revoked_grant() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-lease.json");
        let trusted = fixture_location(dir.path());
        let lock = lifecycle_lock(&trusted).unwrap();
        lock.commit(&trusted, &tasks_store("personal", Some("r1"), 3600), None)
            .unwrap();
        // A different durable grant is never deleted.
        assert!(!lock.remove_revoked(&trusted, Some("r2"), "a").unwrap());
        assert!(path.exists());
        // The exact revoked refresh grant is removed.
        assert!(lock.remove_revoked(&trusted, Some("r1"), "a").unwrap());
        assert!(!path.exists());
        // Access-only leases match on the access token.
        lock.commit(&trusted, &tasks_store("personal", None, 3600), None)
            .unwrap();
        assert!(!lock.remove_revoked(&trusted, None, "other").unwrap());
        assert!(path.exists());
        assert!(lock.remove_revoked(&trusted, None, "a").unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn rotation_replacement_is_persisted_when_returned() {
        let stored = tasks_store("personal", Some("r1"), 3600);
        let granted = TokenResponse {
            access_token: "t2".into(),
            token_type: "Bearer".into(),
            expires_in: Some(serde_json::json!(3600)),
            refresh_token: Some("brand-new".into()),
            scope: GoogleScope::TasksReadOnly.as_str().into(),
        };
        // Google returned a replacement credential: it becomes the durable one.
        let rotated = rotated_lease(&stored, &granted, "r1".into()).unwrap();
        assert_eq!(rotated.refresh_token.as_deref(), Some("brand-new"));
        // No replacement: the submitted credential is retained.
        let without_replacement = TokenResponse { refresh_token: None, ..granted };
        let retained = rotated_lease(&stored, &without_replacement, "r1".into()).unwrap();
        assert_eq!(retained.refresh_token.as_deref(), Some("r1"));
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn lifecycle_lock_is_exclusive_across_threads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-lease.json");
        let holder_trusted = trusted_parent(&path).unwrap();
        let holder = lifecycle_lock(&holder_trusted).unwrap();
        let contender = std::thread::spawn(move || {
            let trusted = trusted_parent(&path).unwrap();
            let started = std::time::Instant::now();
            let _lock = lifecycle_lock(&trusted).unwrap();
            started.elapsed()
        });
        std::thread::sleep(Duration::from_millis(400));
        drop(holder);
        let waited = contender.join().unwrap();
        assert!(
            waited >= Duration::from_millis(300),
            "the second lifecycle lock did not wait for the first: {waited:?}"
        );
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn symlinked_lock_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-lease.json");
        let trusted = fixture_location(dir.path());
        let lock_path = dir.path().join("google-lease.json.lock");
        std::os::unix::fs::symlink(dir.path().join("elsewhere"), &lock_path).unwrap();
        assert!(lifecycle_lock(&trusted).is_err());
        // The store path itself was never touched.
        assert!(!path.exists());
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn allow_acls_on_store_and_ancestors_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-lease.json");
        std::fs::write(
            &path,
            store_json(3600, &["https://www.googleapis.com/auth/tasks.readonly"], true),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let chmod = |entry: &str, target: &std::path::Path| {
            std::process::Command::new("/bin/chmod")
                .args(["+a", entry, target.to_str().unwrap()])
                .output()
                .unwrap()
        };
        // An ALLOW entry exposes the 0600 file to another identity: refused
        // before any byte is read.
        assert!(chmod("nobody allow read", &path).status.success());
        let trusted = trusted_parent(&path).unwrap();
        let error = load_store(&trusted).err().unwrap().to_string();
        assert!(error.contains("ALLOW extended ACL"), "{error}");
        // Clearing the ALLOW entry restores the exact same inode for use.
        let cleared = std::process::Command::new("/bin/chmod")
            .args(["-a", "nobody allow read", path.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(cleared.status.success());
        let trusted = trusted_parent(&path).unwrap();
        assert!(load_store(&trusted).is_ok());
        // An ALLOW entry on an ancestor could permit rename swaps: refused.
        assert!(chmod("nobody allow search", dir.path()).status.success());
        let error = trusted_parent(&path).err().unwrap().to_string();
        assert!(error.contains("ALLOW extended ACL"), "{error}");
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn deny_delete_acl_is_benign() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-lease.json");
        std::fs::write(
            &path,
            store_json(3600, &["https://www.googleapis.com/auth/tasks.readonly"], true),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let applied = std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone deny delete", path.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(applied.status.success());
        let trusted = trusted_parent(&path).unwrap();
        assert!(load_store(&trusted).is_ok());
    }

    #[cfg(all(unix, any(feature = "caldav", feature = "lifetime")))]
    #[test]
    fn store_path_through_symlink_canonicalizes() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("link")).unwrap();
        let path = dir.path().join("link").join("google-lease.json");
        std::fs::write(
            &path,
            store_json(3600, &["https://www.googleapis.com/auth/tasks.readonly"], true),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        // The configured path goes through a symlink (like macOS /var); the
        // canonical walk must resolve it once and then pin the real inodes.
        let trusted = trusted_parent(&path).unwrap();
        let store = load_store(&trusted).unwrap();
        assert_eq!(store.account_ref, "personal");
    }
}
