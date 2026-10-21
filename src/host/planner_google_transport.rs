//! Bounded native Google Calendar/Tasks transport for the existing planner outbox.
//! Account credentials are injected as short-lived, scope-checked leases; endpoints
//! are fixed in production and loopback-only when a fixture URL is explicitly chosen.
use super::planner_sync::{
    Adapter, AdapterFuture, Condition, ConditionalWrite, CreatedItemReceipt, Inventory,
    ObservationTarget, RemoteResource, SyncPhase, WireFormat, WriteOutcome,
};
use crate::adapters::personal_connectors::google_oauth::{
    GoogleScope, GoogleTokenLeaseProvider,
};
use anyhow::{anyhow, bail, Result};
use reqwest::{
    header::{self, HeaderValue},
    Client, Method, Response, StatusCode, Url,
};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    net::IpAddr,
    sync::Arc,
    time::{Duration, SystemTime},
};

const MAX_RESPONSE: usize = 1_048_576;
const MAX_INVENTORY_BYTES: usize = 16_777_216;
const MAX_ITEMS: usize = 10_000;
const MAX_PAGES: usize = 100;
const MAX_PAGE_TOKEN: usize = 4096;
const MAX_ETAG: usize = 8192;
const MAX_REFERENCE: usize = 1024;

#[derive(Clone, Copy)]
enum SendFailure {
    Preflight,
    Network,
}

impl SendFailure {
    fn message(self) -> &'static str {
        match self {
            Self::Preflight => "Google account scope or token lease denied",
            Self::Network => "Google planner request unavailable",
        }
    }
}

pub struct GooglePlannerAdapter {
    binding: String,
    account_ref: String,
    collection_ref: String,
    format: WireFormat,
    phase: SyncPhase,
    token_leases: Arc<dyn GoogleTokenLeaseProvider>,
    api_root: Url,
    client: Client,
    inventory_timeout: Duration,
}

impl GooglePlannerAdapter {
    /// Production endpoints cannot be overridden or redirected to a fixture host.
    pub fn https(
        binding: &str,
        account_ref: &str,
        collection_ref: &str,
        format: WireFormat,
        phase: SyncPhase,
        token_leases: Arc<dyn GoogleTokenLeaseProvider>,
    ) -> Result<Self> {
        let root = match format {
            WireFormat::GoogleCalendar => "https://www.googleapis.com/",
            WireFormat::GoogleTasks => "https://tasks.googleapis.com/",
            WireFormat::ICalendar => bail!("Google transport requires a native Google format"),
        };
        Self::build(
            binding,
            account_ref,
            collection_ref,
            format,
            phase,
            token_leases,
            root,
            false,
            Duration::from_secs(10),
            Duration::from_secs(60),
        )
    }

    /// Explicit HTTP fixture constructor; the URL must contain a literal loopback IP.
    /// It is never consulted by `https` or used as an automatic fallback.
    pub fn loopback_fixture(
        binding: &str,
        account_ref: &str,
        collection_ref: &str,
        format: WireFormat,
        phase: SyncPhase,
        token_leases: Arc<dyn GoogleTokenLeaseProvider>,
        api_root: &str,
        timeout: Duration,
    ) -> Result<Self> {
        Self::build(
            binding,
            account_ref,
            collection_ref,
            format,
            phase,
            token_leases,
            api_root,
            true,
            timeout.min(Duration::from_secs(60)),
            timeout.min(Duration::from_secs(60)),
        )
    }

    fn build(
        binding: &str,
        account_ref: &str,
        collection_ref: &str,
        format: WireFormat,
        phase: SyncPhase,
        token_leases: Arc<dyn GoogleTokenLeaseProvider>,
        root: &str,
        fixture: bool,
        timeout: Duration,
        inventory_timeout: Duration,
    ) -> Result<Self> {
        if binding.is_empty()
            || binding.len() > MAX_REFERENCE
            || !safe_reference(account_ref, 512)
            || !safe_reference(collection_ref, MAX_REFERENCE)
            || matches!(collection_ref, "primary" | "@default")
            || format == WireFormat::ICalendar
            || !matches!(timeout.as_millis(), 1..=60_000)
        {
            bail!("invalid Google planner binding or exact collection identity");
        }
        let api_root = Url::parse(root).map_err(|_| anyhow!("invalid Google API root"))?;
        if !api_root.username().is_empty()
            || api_root.password().is_some()
            || api_root.query().is_some()
            || api_root.fragment().is_some()
            || !api_root.path().ends_with('/')
        {
            bail!("invalid Google API root");
        }
        let loopback_http = fixture
            && api_root.scheme() == "http"
            && api_root
                .host_str()
                .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
                .is_some_and(|ip| ip.is_loopback());
        if fixture && !loopback_http {
            bail!("fixture endpoint must use literal loopback HTTP");
        }
        if !fixture && (api_root.scheme() != "https" || !fixed_google_origin(&api_root, format)) {
            bail!("production Google API origin is fixed HTTPS");
        }
        let client = Client::builder()
            .use_rustls_tls()
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .https_only(!fixture)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .referer(false)
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .http1_only()
            .pool_max_idle_per_host(0)
            .connect_timeout(timeout.min(Duration::from_secs(2)))
            .timeout(timeout)
            .build()
            .map_err(|_| anyhow!("Google HTTP client unavailable"))?;
        Ok(Self {
            binding: binding.into(),
            account_ref: account_ref.into(),
            collection_ref: collection_ref.into(),
            format,
            phase,
            token_leases,
            api_root,
            client,
            inventory_timeout,
        })
    }

    fn base_path(&self, item_id: Option<&str>, page_token: Option<&str>) -> Result<Url> {
        let mut url = self.api_root.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| anyhow!("Google API root cannot contain path segments"))?;
            segments.pop_if_empty();
            match self.format {
                WireFormat::GoogleCalendar => {
                    segments.push("calendar").push("v3").push("calendars");
                    segments.push(&self.collection_ref).push("events");
                }
                WireFormat::GoogleTasks => {
                    segments.push("tasks").push("v1").push("lists");
                    segments.push(&self.collection_ref).push("tasks");
                }
                WireFormat::ICalendar => bail!("Google transport has no iCalendar endpoint"),
            }
            if let Some(item_id) = item_id {
                if !safe_provider_id(self.format, item_id) {
                    bail!("invalid Google provider item id");
                }
                segments.push(item_id);
            }
        }
        if let Some(page_token) = page_token {
            if page_token.is_empty()
                || page_token.len() > MAX_PAGE_TOKEN
                || page_token.chars().any(char::is_control)
            {
                bail!("invalid Google pagination token");
            }
            url.query_pairs_mut().append_pair("pageToken", page_token);
        }
        Ok(url)
    }

    fn scope(&self, write: bool) -> Result<GoogleScope> {
        if write && self.phase != SyncPhase::ExplicitActive {
            bail!("Google writes require explicit_active phase");
        }
        match (self.format, self.phase, write) {
            (WireFormat::GoogleCalendar, SyncPhase::ReadOnlyImport | SyncPhase::Reconcile, _) => {
                Ok(GoogleScope::CalendarEventsReadOnly)
            }
            (WireFormat::GoogleCalendar, SyncPhase::ExplicitActive, true) => {
                Ok(GoogleScope::CalendarEvents)
            }
            (WireFormat::GoogleCalendar, SyncPhase::ExplicitActive, false) => {
                Ok(GoogleScope::CalendarEventsReadOnly)
            }
            (WireFormat::GoogleTasks, SyncPhase::ReadOnlyImport | SyncPhase::Reconcile, _) => {
                Ok(GoogleScope::TasksReadOnly)
            }
            (WireFormat::GoogleTasks, SyncPhase::ExplicitActive, true) => {
                Ok(GoogleScope::Tasks)
            }
            (WireFormat::GoogleTasks, SyncPhase::ExplicitActive, false) => {
                Ok(GoogleScope::TasksReadOnly)
            }
            (WireFormat::ICalendar, _, _) => bail!("Google scope requested for iCalendar"),
        }
    }

    async fn send(
        &self,
        method: Method,
        url: Url,
        write: bool,
        body: Option<&str>,
        condition: Option<&Condition>,
    ) -> std::result::Result<Response, SendFailure> {
        let scope = self.scope(write).map_err(|_| SendFailure::Preflight)?;
        let required = [scope];
        let lease = self
            .token_leases
            .lease(&self.account_ref, &required)
            .await
            .map_err(|_| SendFailure::Preflight)?;
        if lease.account_ref() != self.account_ref
            || SystemTime::now() >= lease.expires_at()
            || !lease.grants(scope)
            || lease.access_token().is_empty()
            || lease
                .access_token()
                .bytes()
                .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
        {
            return Err(SendFailure::Preflight);
        }
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(lease.access_token());
        if let Some(body) = body {
            request = request
                .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
                .body(body.to_owned());
        }
        if let Some(Condition::Match(etag)) = condition {
            if !strong_etag(etag) {
                return Err(SendFailure::Preflight);
            }
            let value =
                HeaderValue::from_str(etag).map_err(|_| SendFailure::Preflight)?;
            request = request.header(header::IF_MATCH, value);
        }
        request.send().await.map_err(|_| SendFailure::Network)
    }

    async fn read_limited(response: &mut Response, limit: usize) -> Result<Vec<u8>> {
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            bail!("Google response exceeds byte limit");
        }
        let capacity = response
            .content_length()
            .unwrap_or(0)
            .min(limit as u64) as usize;
        let mut bytes = Vec::with_capacity(capacity);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow!("Google response body unavailable"))?
        {
            if bytes.len().saturating_add(chunk.len()) > limit {
                bail!("Google response exceeds byte limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    async fn inventory_inner(&self) -> Result<Inventory> {
        let mut items = Vec::new();
        let mut provider_ids = BTreeSet::new();
        let mut page_tokens = BTreeSet::new();
        let mut page_token: Option<String> = None;
        let mut total_bytes = 0usize;
        for _ in 0..MAX_PAGES {
            let mut url = self.base_path(None, page_token.as_deref())?;
            {
                let mut query = url.query_pairs_mut();
                match self.format {
                    WireFormat::GoogleCalendar => {
                        query.append_pair("maxResults", "2500");
                        query.append_pair("showHiddenInvitations", "true");
                        query.append_pair("showDeleted", "false");
                    }
                    WireFormat::GoogleTasks => {
                        query.append_pair("maxResults", "100");
                        query.append_pair("showCompleted", "true");
                        query.append_pair("showHidden", "true");
                        query.append_pair("showAssigned", "true");
                    }
                    WireFormat::ICalendar => unreachable!(),
                }
            }
            let mut response = self
                .send(Method::GET, url, false, None, None)
                .await
                .map_err(|failure| anyhow!(failure.message()))?;
            if response.status() != StatusCode::OK {
                bail!("Google full inventory request failed");
            }
            let bytes = Self::read_limited(&mut response, MAX_RESPONSE).await?;
            total_bytes = total_bytes.saturating_add(bytes.len());
            if total_bytes > MAX_INVENTORY_BYTES {
                bail!("Google inventory exceeds total byte limit");
            }
            let page: Value = serde_json::from_slice(&bytes)
                .map_err(|_| anyhow!("invalid Google inventory JSON"))?;
            let rows = page
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("Google inventory page has no item array"))?;
            for row in rows {
                if items.len() >= MAX_ITEMS {
                    bail!("Google inventory exceeds item limit");
                }
                let id = row
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| safe_provider_id(self.format, id))
                    .ok_or_else(|| anyhow!("Google inventory item id is missing or invalid"))?;
                if !provider_ids.insert(id.to_owned()) {
                    bail!("duplicate Google provider item id");
                }
                let etag = item_etag(row)?;
                let raw = serde_json::to_string(row)?;
                if raw.len() > MAX_RESPONSE {
                    bail!("Google item exceeds byte limit");
                }
                items.push(RemoteResource {
                    uid: id.to_owned(),
                    href: provider_locator(self.format, id)?,
                    etag,
                    raw,
                });
            }
            match page.get("nextPageToken").and_then(Value::as_str) {
                None | Some("") => {
                    return Ok(Inventory {
                        complete: true,
                        items,
                    });
                }
                Some(next) => {
                    if next.len() > MAX_PAGE_TOKEN
                        || next.chars().any(char::is_control)
                        || !page_tokens.insert(next.to_owned())
                    {
                        bail!("invalid or repeated Google inventory page token");
                    }
                    page_token = Some(next.to_owned());
                }
            }
        }
        bail!("Google inventory page limit exceeded")
    }

    async fn observe_exact(&self, target: ObservationTarget<'_>) -> Result<Option<RemoteResource>> {
        if target.create
            && (target.operation_id.is_empty() || target.operation_id.len() > 128)
        {
            bail!("Google create observation requires its durable operation id");
        }
        if target.create
            && self.format == WireFormat::GoogleTasks
            && target.provider_item_id.is_none()
        {
            bail!("Google Tasks create has no observed provider receipt; replay is prohibited");
        }
        let provider_id = target
            .provider_item_id
            .ok_or_else(|| anyhow!("Google observation requires an exact provider item id"))?;
        if !safe_provider_id(self.format, provider_id) {
            bail!("invalid Google observation provider id");
        }
        let locator = provider_locator(self.format, provider_id)?;
        if target
            .observation_locator
            .is_some_and(|stored| stored != locator)
        {
            bail!("persisted Google locator/provider id mismatch");
        }
        let mut response = self
            .send(
                Method::GET,
                self.base_path(Some(provider_id), None)?,
                false,
                None,
                None,
            )
            .await
            .map_err(|failure| anyhow!(failure.message()))?;
        if response.status() == StatusCode::NOT_FOUND {
            if target.create && self.format == WireFormat::GoogleCalendar {
                return Ok(None);
            }
            bail!("Google item-level 404 is not authoritative collection absence");
        }
        if response.status() != StatusCode::OK {
            bail!("Google exact item observation failed");
        }
        let bytes = Self::read_limited(&mut response, MAX_RESPONSE).await?;
        let row: Value = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow!("invalid Google item JSON"))?;
        let returned_id = row
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Google exact item has no id"))?;
        if returned_id != provider_id {
            bail!("Google exact item id mismatch");
        }
        Ok(Some(RemoteResource {
            uid: target.uid.to_owned(),
            href: locator,
            etag: item_etag(&row)?,
            raw: serde_json::to_string(&row)?,
        }))
    }

    async fn write_request(
        &self,
        request: ConditionalWrite,
        operation_id: Option<&str>,
        body: Option<&str>,
    ) -> Result<WriteOutcome> {
        let create = matches!(&request.condition, Condition::Absent);
        if create
            && operation_id.is_none_or(|id| {
                id.is_empty() || id.len() > 128 || id.chars().any(char::is_control)
            })
        {
            return Ok(WriteOutcome::NotDispatched);
        }
        let method = if create {
            Method::POST
        } else if request.raw.is_some() {
            Method::PATCH
        } else {
            Method::DELETE
        };
        let payload = body.or(request.raw.as_deref());
        if method != Method::DELETE && payload.is_none() {
            return Ok(WriteOutcome::NotDispatched);
        }
        let item_id = if create {
            None
        } else {
            match locator_id(self.format, &request.href) {
                Ok(id) => Some(id),
                Err(_) => return Ok(WriteOutcome::NotDispatched),
            }
        };
        let expected_calendar_id = if create && self.format == WireFormat::GoogleCalendar {
            let expected_id = match locator_id(self.format, &request.href) {
                Ok(id) => id,
                Err(_) => return Ok(WriteOutcome::NotDispatched),
            };
            let value: Value = match serde_json::from_str(payload.unwrap()) {
                Ok(value) => value,
                Err(_) => return Ok(WriteOutcome::NotDispatched),
            };
            if value.get("id").and_then(Value::as_str) != Some(expected_id.as_str()) {
                return Ok(WriteOutcome::NotDispatched);
            }
            Some(expected_id)
        } else {
            None
        };
        if create && self.format == WireFormat::GoogleTasks {
            let value: Value = match serde_json::from_str(payload.unwrap()) {
                Ok(value) => value,
                Err(_) => return Ok(WriteOutcome::NotDispatched),
            };
            if value.get("id").is_some() {
                return Ok(WriteOutcome::NotDispatched);
            }
        }
        let url = match self.base_path(item_id.as_deref(), None) {
            Ok(url) => url,
            Err(_) => return Ok(WriteOutcome::NotDispatched),
        };
        let mut response = match self
            .send(method, url, true, payload, Some(&request.condition))
            .await
        {
            Ok(response) => response,
            Err(SendFailure::Preflight) => return Ok(WriteOutcome::NotDispatched),
            Err(SendFailure::Network) => return Ok(WriteOutcome::Uncertain),
        };
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Ok(WriteOutcome::PreconditionFailed);
        }
        let status = response.status();
        let accepted = if create {
            status == StatusCode::OK || status == StatusCode::CREATED
        } else {
            status == StatusCode::OK || status == StatusCode::NO_CONTENT
        };
        if !accepted {
            return Ok(WriteOutcome::Uncertain);
        }
        if !create {
            return Ok(WriteOutcome::Applied);
        }
        let bytes = match Self::read_limited(&mut response, MAX_RESPONSE).await {
            Ok(bytes) => bytes,
            Err(_) => return Ok(WriteOutcome::Uncertain),
        };
        let row: Value = match serde_json::from_slice(&bytes) {
            Ok(row) => row,
            Err(_) => return Ok(WriteOutcome::Uncertain),
        };
        let provider_item_id = match row.get("id").and_then(Value::as_str) {
            Some(id) if safe_provider_id(self.format, id) => id.to_owned(),
            _ => return Ok(WriteOutcome::Uncertain),
        };
        if expected_calendar_id.as_deref() != None
            && expected_calendar_id.as_deref() != Some(provider_item_id.as_str())
        {
            return Ok(WriteOutcome::Uncertain);
        }
        let observation_locator = match provider_locator(self.format, &provider_item_id) {
            Ok(locator) => locator,
            Err(_) => return Ok(WriteOutcome::Uncertain),
        };
        Ok(WriteOutcome::AppliedWithReceipt(CreatedItemReceipt {
            observation_locator,
            provider_item_id,
        }))
    }
}

impl Adapter for GooglePlannerAdapter {
    fn binding(&self) -> &str {
        &self.binding
    }
    fn wire_format(&self) -> WireFormat {
        self.format
    }
    fn phase(&self) -> SyncPhase {
        self.phase
    }
    fn account_ref(&self) -> Option<&str> {
        Some(&self.account_ref)
    }
    fn collection_ref(&self) -> Option<&str> {
        Some(&self.collection_ref)
    }
    fn inventory(&self) -> AdapterFuture<'_, Inventory> {
        Box::pin(async move {
            tokio::time::timeout(self.inventory_timeout, self.inventory_inner())
                .await
                .map_err(|_| anyhow!("Google inventory time budget exceeded"))?
        })
    }
    fn observe_uid<'a>(&'a self, uid: &'a str) -> AdapterFuture<'a, Option<RemoteResource>> {
        Box::pin(async move {
            let locator = provider_locator(self.format, uid)?;
            self.observe_exact(ObservationTarget {
                uid,
                delete: false,
                operation_id: "",
                provider_item_id: Some(uid),
                observation_locator: Some(&locator),
                create: false,
            })
            .await
        })
    }
    fn observe_target<'a>(
        &'a self,
        target: ObservationTarget<'a>,
    ) -> AdapterFuture<'a, Option<RemoteResource>> {
        Box::pin(async move { self.observe_exact(target).await })
    }
    fn write(&self, request: ConditionalWrite) -> AdapterFuture<'_, WriteOutcome> {
        Box::pin(async move { self.write_request(request, None, None).await })
    }
    fn write_operation<'a>(
        &'a self,
        request: ConditionalWrite,
        operation_id: &'a str,
        json_body: Option<&'a str>,
    ) -> AdapterFuture<'a, WriteOutcome> {
        Box::pin(async move {
            self.write_request(request, Some(operation_id), json_body)
                .await
        })
    }
}

fn fixed_google_origin(url: &Url, format: WireFormat) -> bool {
    let (host, path) = match format {
        WireFormat::GoogleCalendar => ("www.googleapis.com", "/"),
        WireFormat::GoogleTasks => ("tasks.googleapis.com", "/"),
        WireFormat::ICalendar => return false,
    };
    url.host_str() == Some(host) && url.path() == path && url.port().is_none()
}

fn safe_reference(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn safe_provider_id(format: WireFormat, value: &str) -> bool {
    match format {
        WireFormat::GoogleCalendar => {
            (5..=1024).contains(&value.len())
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'v').contains(&b))
        }
        WireFormat::GoogleTasks => {
            !value.is_empty()
                && value.len() <= 512
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        }
        WireFormat::ICalendar => false,
    }
}

fn provider_locator(format: WireFormat, item_id: &str) -> Result<String> {
    if !safe_provider_id(format, item_id) {
        bail!("invalid Google provider item id");
    }
    Ok(format!(
        "{}/{}",
        if format == WireFormat::GoogleCalendar {
            "events"
        } else {
            "tasks"
        },
        item_id
    ))
}

fn locator_id(format: WireFormat, locator: &str) -> Result<String> {
    let prefix = match format {
        WireFormat::GoogleCalendar => "events/",
        WireFormat::GoogleTasks => "tasks/",
        WireFormat::ICalendar => bail!("iCalendar locator passed to Google transport"),
    };
    let item_id = locator
        .strip_prefix(prefix)
        .ok_or_else(|| anyhow!("Google locator format mismatch"))?;
    if !safe_provider_id(format, item_id) {
        bail!("invalid Google locator id");
    }
    Ok(item_id.to_owned())
}

fn item_etag(item: &Value) -> Result<String> {
    let etag = item
        .get("etag")
        .and_then(Value::as_str)
        .filter(|etag| {
            !etag.is_empty()
                && etag.len() <= MAX_ETAG
                && !etag.chars().any(char::is_control)
        })
        .ok_or_else(|| anyhow!("Google item ETag missing or invalid"))?;
    Ok(etag.to_owned())
}
fn strong_etag(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2
        && bytes.first() == Some(&b'"')
        && bytes.last() == Some(&b'"')
        && bytes[1..bytes.len() - 1]
            .iter()
            .all(|byte| matches!(byte, 0x21 | 0x23..=0x7e | 0x80..=0xff))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        adapters::personal_connectors::google_oauth::{
            GoogleTokenLease, GoogleTokenLeaseFuture,
        },
        host::planner_sync::{
            google_test_support as support, Mutation, Verb,
        },
    };
    use serde_json::json;
    use parking_lot::Mutex;
    use std::{
        collections::BTreeMap,
        io::{Read, Write},
        net::{Shutdown, TcpListener, TcpStream},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        },
        thread::{self, JoinHandle},
        time::{Duration, SystemTime},
    };

    struct LeaseFixture {
        account_ref: String,
        expires_at: SystemTime,
        calls: AtomicUsize,
        scopes: Vec<GoogleScope>,
    }

    impl LeaseFixture {
        fn valid() -> Arc<Self> {
            Self::for_account(
                "fixture-account",
                SystemTime::now() + Duration::from_secs(3600),
            )
        }

        fn for_account(account_ref: &str, expires_at: SystemTime) -> Arc<Self> {
            Self::with_scopes(
                account_ref,
                expires_at,
                vec![
                    GoogleScope::CalendarEventsReadOnly,
                    GoogleScope::CalendarEvents,
                    GoogleScope::TasksReadOnly,
                    GoogleScope::Tasks,
                ],
            )
        }

        fn with_scopes(
            account_ref: &str,
            expires_at: SystemTime,
            scopes: Vec<GoogleScope>,
        ) -> Arc<Self> {
            Arc::new(Self {
                account_ref: account_ref.into(),
                expires_at,
                calls: AtomicUsize::new(0),
                scopes,
            })
        }
    }

    impl GoogleTokenLeaseProvider for LeaseFixture {
        fn lease<'a>(
            &'a self,
            _account_ref: &'a str,
            _required_scopes: &'a [GoogleScope],
        ) -> GoogleTokenLeaseFuture<'a> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(GoogleTokenLease::new(
                    self.account_ref.clone(),
                    "fixture-token".into(),
                    self.expires_at.clone(),
                    self.scopes.clone(),
                ))
            })
        }
    }

    #[derive(Clone)]
    struct RecordedRequest {
        method: String,
        body: String,
        if_match: Option<String>,
    }

    struct IncomingRequest {
        method: String,
        path: String,
        body: String,
        headers: BTreeMap<String, String>,
    }

    enum FixtureReply {
        Drop,
        Response(u16, Vec<u8>),
    }

    struct FixtureState {
        format: WireFormat,
        items: BTreeMap<String, Value>,
        requests: Vec<RecordedRequest>,
        drop_next_insert: bool,
        next_task_id: usize,
        next_etag: usize,
        page_size: usize,
    }

    struct FixtureServer {
        api_root: String,
        address: String,
        state: Arc<Mutex<FixtureState>>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl FixtureServer {
        fn start(format: WireFormat, drop_next_insert: bool) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = listener.local_addr().unwrap().to_string();
            let state = Arc::new(Mutex::new(FixtureState {
                format,
                items: BTreeMap::new(),
                requests: Vec::new(),
                drop_next_insert,
                next_task_id: 0,
                next_etag: 0,
                page_size: usize::MAX,
            }));
            let stop = Arc::new(AtomicBool::new(false));
            let thread_state = state.clone();
            let thread_stop = stop.clone();
            let thread = thread::spawn(move || {
                while let Ok((mut stream, _)) = listener.accept() {
                    if thread_stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Some(request) = read_request(&mut stream) {
                        match handle_request(&thread_state, request) {
                            FixtureReply::Drop => {
                                let _ = stream.shutdown(Shutdown::Both);
                            }
                            FixtureReply::Response(status, body) => {
                                let _ = write_response(&mut stream, status, &body);
                            }
                        }
                    }
                }
            });
            Self {
                api_root: format!("http://{address}/"),
                address,
                state,
                stop,
                thread: Some(thread),
            }
        }

        fn seed(&self, id: &str, item: Value) {
            self.state
                .lock()
                .items
                .insert(id.into(), item);
        }

        fn set_page_size(&self, page_size: usize) {
            self.state.lock().page_size = page_size;
        }

        fn item(&self, id: &str) -> Option<Value> {
            self.state.lock().items.get(id).cloned()
        }

        fn requests(&self) -> Vec<RecordedRequest> {
            self.state.lock().requests.clone()
        }

        fn external_title_change(&self, id: &str, title: &str) {
            let mut state = self.state.lock();
            state.next_etag += 1;
            let etag = format!("\"external-{}\"", state.next_etag);
            let title_field = if state.format == WireFormat::GoogleCalendar {
                "summary"
            } else {
                "title"
            };
            let item = state.items.get_mut(id).unwrap();
            item[title_field] = Value::String(title.into());
            item["etag"] = Value::String(etag);
        }
    }

    impl Drop for FixtureServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(&self.address);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn read_request(stream: &mut TcpStream) -> Option<IncomingRequest> {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut header_end = None;
        let mut content_length = 0usize;
        loop {
            let count = stream.read(&mut chunk).ok()?;
            if count == 0 {
                return None;
            }
            bytes.extend_from_slice(&chunk[..count]);
            if header_end.is_none() {
                if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                    let header = std::str::from_utf8(&bytes[..index]).ok()?;
                    let mut lines = header.split("\r\n");
                    let mut request_line = lines.next()?.split_whitespace();
                    let method = request_line.next()?.to_owned();
                    let path = request_line.next()?.to_owned();
                    let mut headers = BTreeMap::new();
                    for line in lines {
                        if let Some((name, value)) = line.split_once(':') {
                            headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
                        }
                    }
                    content_length = headers
                        .get("content-length")
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0);
                    header_end = Some((index + 4, method, path, headers));
                }
            }
            if let Some((end, _, _, _)) = header_end.as_ref() {
                if bytes.len() >= (*end).saturating_add(content_length) {
                    let (end, method, path, headers) = header_end.take().unwrap();
                    let body =
                        String::from_utf8(bytes[end..end + content_length].to_vec()).ok()?;
                    return Some(IncomingRequest {
                        method,
                        path,
                        body,
                        headers,
                    });
                }
            }
            if bytes.len() > MAX_RESPONSE + 16_384 {
                return None;
            }
        }
    }

    fn json_reply(status: u16, value: Value) -> FixtureReply {
        FixtureReply::Response(status, serde_json::to_vec(&value).unwrap())
    }

    fn handle_request(
        state: &Arc<Mutex<FixtureState>>,
        request: IncomingRequest,
    ) -> FixtureReply {
        let mut state = state.lock();
        let if_match = request.headers.get("if-match").cloned();
        state.requests.push(RecordedRequest {
            method: request.method.clone(),
            body: request.body.clone(),
            if_match,
        });
        let path = request.path.split('?').next().unwrap_or(&request.path);
        let collection_suffix = if state.format == WireFormat::GoogleCalendar {
            "/events"
        } else {
            "/tasks"
        };
        if request.method == "GET" && path.ends_with(collection_suffix) {
            let rows: Vec<_> = state.items.values().cloned().collect();
            let page_token = request
                .path
                .split_once('?')
                .and_then(|(_, query)| {
                    query
                        .split('&')
                        .find_map(|pair| pair.strip_prefix("pageToken="))
                });
            let start = if page_token == Some("fixture-page-2") {
                state.page_size
            } else {
                0
            };
            let end = start.saturating_add(state.page_size).min(rows.len());
            let page_rows = rows.get(start..end).unwrap_or_default().to_vec();
            let mut page = json!({"items":page_rows});
            if end < rows.len() {
                page["nextPageToken"] = Value::String("fixture-page-2".into());
            }
            return json_reply(200, page);
        }
        if request.method == "POST" && path.ends_with(collection_suffix) {
            let mut item: Value = match serde_json::from_str(&request.body) {
                Ok(item) => item,
                Err(_) => return json_reply(400, json!({"error":"invalid fixture JSON"})),
            };
            let id = if state.format == WireFormat::GoogleCalendar {
                match item.get("id").and_then(Value::as_str) {
                    Some(id) => id.to_owned(),
                    None => return json_reply(400, json!({"error":"missing Calendar id"})),
                }
            } else {
                state.next_task_id += 1;
                format!("provider-task-{}", state.next_task_id)
            };
            if state.items.contains_key(&id) {
                return json_reply(409, json!({"error":"duplicate fixture id"}));
            }
            state.next_etag += 1;
            item["id"] = Value::String(id.clone());
            item["etag"] = Value::String(format!("\"fixture-{}\"", state.next_etag));
            state.items.insert(id, item.clone());
            if state.drop_next_insert {
                state.drop_next_insert = false;
                return FixtureReply::Drop;
            }
            return json_reply(200, item);
        }
        let item_id = path.rsplit('/').next().unwrap_or_default();
        if request.method == "GET" {
            return match state.items.get(item_id) {
                Some(item) => json_reply(200, item.clone()),
                None => json_reply(404, json!({"error":"missing fixture item"})),
            };
        }
        if request.method == "PATCH" || request.method == "DELETE" {
            let Some(old) = state.items.get(item_id) else {
                return json_reply(404, json!({"error":"missing fixture item"}));
            };
            if request.headers.get("if-match").map(String::as_str)
                != old.get("etag").and_then(Value::as_str)
            {
                return json_reply(412, json!({"error":"etag mismatch"}));
            }
            if request.method == "DELETE" {
                state.items.remove(item_id);
                return FixtureReply::Response(204, Vec::new());
            }
            let patch: Value = match serde_json::from_str(&request.body) {
                Ok(patch) => patch,
                Err(_) => return json_reply(400, json!({"error":"invalid fixture patch"})),
            };
            let Some(fields) = patch.as_object() else {
                return json_reply(400, json!({"error":"fixture patch must be an object"}));
            };
            state.next_etag += 1;
            let etag = format!("\"fixture-{}\"", state.next_etag);
            let item = state.items.get_mut(item_id).unwrap();
            for (key, value) in fields {
                if value.is_null() {
                    item.as_object_mut().unwrap().remove(key);
                } else {
                    item[key] = value.clone();
                }
            }
            item["etag"] = Value::String(etag);
            return json_reply(200, item.clone());
        }
        json_reply(404, json!({"error":"unknown fixture path"}))
    }

    fn write_response(stream: &mut TcpStream, status: u16, body: &[u8]) -> std::io::Result<()> {
        let phrase = match status {
            200 => "OK",
            201 => "Created",
            204 => "No Content",
            400 => "Bad Request",
            404 => "Not Found",
            409 => "Conflict",
            412 => "Precondition Failed",
            _ => "Fixture Response",
        };
        write!(
            stream,
            "HTTP/1.1 {status} {phrase}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            body.len()
        )?;
        stream.write_all(body)
    }

    fn adapter(
        server: &FixtureServer,
        cid: &str,
        format: WireFormat,
        phase: SyncPhase,
        leases: Arc<dyn GoogleTokenLeaseProvider>,
    ) -> GooglePlannerAdapter {
        GooglePlannerAdapter::loopback_fixture(
            &format!("fixture-google:{cid}"),
            "fixture-account",
            &format!("fixture-{cid}"),
            format,
            phase,
            leases,
            &server.api_root,
            Duration::from_secs(3),
        )
        .unwrap()
    }

    fn create_event(cid: &str, title: &str) -> Mutation {
        Mutation {
            collection_id: cid.into(),
            uid: None,
            expected_version: None,
            operation: Verb::Create,
            changes: BTreeMap::from([
                ("title".into(), json!(title)),
                ("start_ms".into(), json!(1_800_000_000_000i64)),
                ("end_ms".into(), json!(1_800_003_600_000i64)),
            ]),
        }
    }

    fn patch_mutation(cid: &str, uid: &str, version: u64, title: &str) -> Mutation {
        Mutation {
            collection_id: cid.into(),
            uid: Some(uid.into()),
            expected_version: Some(version),
            operation: Verb::Patch,
            changes: BTreeMap::from([("title".into(), json!(title))]),
        }
    }

    fn calendar_item(id: &str, title: &str, start: Value, end: Value) -> Value {
        json!({
            "kind":"calendar#event",
            "id":id,
            "etag":"\"calendar-seed-1\"",
            "summary":title,
            "start":start,
            "end":end,
            "extendedProperties":{"private":{"opaque":"preserve"}}
        })
    }

    #[tokio::test]
    async fn calendar_lost_insert_receipt_recovers_by_durable_provider_id_and_deduplicates() {
        let (_root, app) = support::host();
        support::configure_google(
            &app,
            "events",
            WireFormat::GoogleCalendar,
            SyncPhase::ReadOnlyImport,
        )
        .unwrap();
        support::activate(&app, "events").unwrap();
        let server = FixtureServer::start(WireFormat::GoogleCalendar, true);
        let leases = LeaseFixture::valid();
        let transport = adapter(
            &server,
            "events",
            WireFormat::GoogleCalendar,
            SyncPhase::ExplicitActive,
            leases,
        );
        let mutation = create_event("events", "lost response");
        let operation = support::enqueue(&app, "owner:calendar-lost", mutation.clone()).unwrap();
        let provider_id = operation.provider_item_id.clone().unwrap();
        let first = app
            .planner_dispatch(&operation.id, &transport)
            .await
            .unwrap();
        assert_eq!(first["phase"], "synced");
        assert_eq!(first["remote_applied"], true);
        assert_eq!(first["write_outcome"], "effect_unknown");
        assert_eq!(
            support::operation(&app, &operation.id)
                .unwrap()
                .observation_locator
                .as_deref(),
            Some(format!("events/{provider_id}").as_str())
        );
        assert_eq!(server.item(&provider_id).unwrap()["summary"], "lost response");

        let duplicate =
            support::enqueue(&app, "owner:calendar-lost", mutation).unwrap();
        app.planner_dispatch(&duplicate.id, &transport)
            .await
            .unwrap();
        let requests = server.requests();
        assert_eq!(requests.iter().filter(|r| r.method == "POST").count(), 1);
        assert_eq!(requests.iter().filter(|r| r.method == "GET").count(), 1);
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn tasks_lost_insert_receipt_remains_effect_unknown_without_content_dedup_or_replay() {
        let (_root, app) = support::host();
        support::configure_google(
            &app,
            "tasks",
            WireFormat::GoogleTasks,
            SyncPhase::ReadOnlyImport,
        )
        .unwrap();
        support::activate(&app, "tasks").unwrap();
        let server = FixtureServer::start(WireFormat::GoogleTasks, true);
        let transport = adapter(
            &server,
            "tasks",
            WireFormat::GoogleTasks,
            SyncPhase::ExplicitActive,
            LeaseFixture::valid(),
        );
        let mutation = Mutation {
            collection_id: "tasks".into(),
            uid: None,
            expected_version: None,
            operation: Verb::Create,
            changes: BTreeMap::from([("title".into(), json!("same visible title"))]),
        };
        let operation = support::enqueue(&app, "owner:tasks-lost", mutation).unwrap();
        let first = app
            .planner_dispatch(&operation.id, &transport)
            .await
            .unwrap();
        assert_eq!(first["phase"], "uncertain");
        assert_eq!(first["write_outcome"], "effect_unknown");
        assert!(support::operation(&app, &operation.id)
            .unwrap()
            .provider_item_id
            .is_none());

        app.planner_dispatch(&operation.id, &transport)
            .await
            .unwrap();
        assert_eq!(
            server
                .requests()
                .iter()
                .filter(|request| request.method == "POST")
                .count(),
            1
        );
        app.planner_pull("tasks", &transport).await.unwrap();
        let orphan = support::resource(&app, "tasks", "provider-task-1").unwrap();
        assert_eq!(orphan.view.title, "same visible title");
        assert_ne!(orphan.uid, operation.uid);
        assert_eq!(
            support::operation(&app, &operation.id).unwrap().state,
            "uncertain"
        );
        assert_eq!(
            server
                .requests()
                .iter()
                .filter(|request| request.method != "GET")
                .count(),
            1
        );
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn tasks_insert_receipt_persists_provider_item_mapping() {
        let (_root, app) = support::host();
        support::configure_google(
            &app,
            "tasks",
            WireFormat::GoogleTasks,
            SyncPhase::ReadOnlyImport,
        )
        .unwrap();
        support::activate(&app, "tasks").unwrap();
        let server = FixtureServer::start(WireFormat::GoogleTasks, false);
        let transport = adapter(
            &server,
            "tasks",
            WireFormat::GoogleTasks,
            SyncPhase::ExplicitActive,
            LeaseFixture::valid(),
        );
        let operation = support::enqueue(
            &app,
            "owner:tasks-insert-receipt",
            Mutation {
                collection_id: "tasks".into(),
                uid: None,
                expected_version: None,
                operation: Verb::Create,
                changes: BTreeMap::from([("title".into(), json!("receipt mapping"))]),
            },
        )
        .unwrap();
        let result = app
            .planner_dispatch(&operation.id, &transport)
            .await
            .unwrap();
        assert_eq!(result["phase"], "synced");
        let persisted = support::operation(&app, &operation.id).unwrap();
        assert_eq!(
            persisted.provider_item_id.as_deref(),
            Some("provider-task-1")
        );
        assert_eq!(
            persisted.observation_locator.as_deref(),
            Some("tasks/provider-task-1")
        );
        let cached = support::resource(&app, "tasks", &operation.uid).unwrap();
        assert_eq!(cached.provider_item_id.as_deref(), Some("provider-task-1"));
        assert_eq!(cached.href, "tasks/provider-task-1");
        assert_eq!(
            server
                .requests()
                .iter()
                .filter(|request| request.method == "POST")
                .count(),
            1
        );
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn wrong_account_and_expired_leases_are_rejected_before_http_dispatch() {
        let no_write_scope = LeaseFixture::with_scopes(
            "fixture-account",
            SystemTime::now() + Duration::from_secs(3600),
            vec![GoogleScope::CalendarEventsReadOnly],
        );
        for leases in [
            LeaseFixture::for_account(
                "different-account",
                SystemTime::now() + Duration::from_secs(3600),
            ),
            LeaseFixture::for_account("fixture-account", SystemTime::UNIX_EPOCH),
            no_write_scope,
        ] {
            let (_root, app) = support::host();
            support::configure_google(
                &app,
                "events",
                WireFormat::GoogleCalendar,
                SyncPhase::ReadOnlyImport,
            )
            .unwrap();
            support::activate(&app, "events").unwrap();
            let server = FixtureServer::start(WireFormat::GoogleCalendar, false);
            let transport = adapter(
                &server,
                "events",
                WireFormat::GoogleCalendar,
                SyncPhase::ExplicitActive,
                leases.clone(),
            );
            let operation = support::enqueue(
                &app,
                "owner:preflight-denial",
                create_event("events", "never sent"),
            )
            .unwrap();
            let denied = app
                .planner_dispatch(&operation.id, &transport)
                .await
                .unwrap();
            assert_eq!(denied["phase"], "queued");
            assert_eq!(denied["write_outcome"], "not_sent");
            assert!(server.requests().is_empty());
            assert_eq!(leases.calls.load(Ordering::SeqCst), 1);
            app.shutdown().await.unwrap();
        }
    }

    #[tokio::test]
    async fn etag_conflict_keeps_remote_calendar_edit_and_preserves_dst_instants() {
        let (_root, app) = support::host();
        let id = "abcde12345";
        let server = FixtureServer::start(WireFormat::GoogleCalendar, false);
        server.seed(
            id,
            calendar_item(
                id,
                "before",
                json!({"dateTime":"2026-11-01T01:30:00-04:00","timeZone":"America/New_York"}),
                json!({"dateTime":"2026-11-01T01:30:00-05:00","timeZone":"America/New_York"}),
            ),
        );
        support::configure_google(
            &app,
            "events",
            WireFormat::GoogleCalendar,
            SyncPhase::ReadOnlyImport,
        )
        .unwrap();
        let import = adapter(
            &server,
            "events",
            WireFormat::GoogleCalendar,
            SyncPhase::ReadOnlyImport,
            LeaseFixture::valid(),
        );
        app.planner_pull("events", &import).await.unwrap();
        let cached = support::resource(&app, "events", id).unwrap();
        assert_eq!(cached.view.end_ms.unwrap() - cached.view.start_ms.unwrap(), 3_600_000);
        support::activate(&app, "events").unwrap();
        let active = adapter(
            &server,
            "events",
            WireFormat::GoogleCalendar,
            SyncPhase::ExplicitActive,
            LeaseFixture::valid(),
        );
        server.external_title_change(id, "remote owner edit");
        let operation = support::enqueue(
            &app,
            "owner:calendar-conflict",
            patch_mutation("events", id, cached.version, "local overwrite"),
        )
        .unwrap();
        let conflict = app
            .planner_dispatch(&operation.id, &active)
            .await
            .unwrap();
        assert_eq!(conflict["phase"], "conflict");
        assert_eq!(conflict["write_outcome"], "precondition_failed");
        let remote = server.item(id).unwrap();
        assert_eq!(remote["summary"], "remote owner edit");
        assert_eq!(
            support::resource(&app, "events", id).unwrap().view.title,
            "remote owner edit"
        );
        assert_eq!(
            remote["extendedProperties"]["private"]["opaque"],
            "preserve"
        );
        let patch = server
            .requests()
            .into_iter()
            .find(|request| request.method == "PATCH")
            .unwrap();
        assert_eq!(patch.if_match.as_deref(), Some("\"calendar-seed-1\""));
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn tasks_patch_preserves_date_only_due_and_unknown_provider_json() {
        let (_root, app) = support::host();
        let id = "task-seed-1";
        let server = FixtureServer::start(WireFormat::GoogleTasks, false);
        server.seed(
            id,
            json!({
                "kind":"tasks#task",
                "id":id,
                "etag":"\"task-seed-1\"",
                "title":"before",
                "notes":"keep these notes",
                "status":"needsAction",
                "due":"2026-11-01T00:00:00.000Z",
                "unknown_provider_metadata":{"opaque":true}
            }),
        );
        support::configure_google(
            &app,
            "tasks",
            WireFormat::GoogleTasks,
            SyncPhase::ReadOnlyImport,
        )
        .unwrap();
        let import = adapter(
            &server,
            "tasks",
            WireFormat::GoogleTasks,
            SyncPhase::ReadOnlyImport,
            LeaseFixture::valid(),
        );
        app.planner_pull("tasks", &import).await.unwrap();
        let cached = support::resource(&app, "tasks", id).unwrap();
        assert_eq!(cached.view.due.as_deref(), Some("2026-11-01"));
        support::activate(&app, "tasks").unwrap();
        let active = adapter(
            &server,
            "tasks",
            WireFormat::GoogleTasks,
            SyncPhase::ExplicitActive,
            LeaseFixture::valid(),
        );
        let operation = support::enqueue(
            &app,
            "owner:task-opaque-patch",
            patch_mutation("tasks", id, cached.version, "after"),
        )
        .unwrap();
        let synced = app
            .planner_dispatch(&operation.id, &active)
            .await
            .unwrap();
        assert_eq!(synced["phase"], "synced");
        let remote = server.item(id).unwrap();
        assert_eq!(remote["title"], "after");
        assert_eq!(remote["notes"], "keep these notes");
        assert_eq!(remote["due"], "2026-11-01T00:00:00.000Z");
        assert_eq!(
            remote["unknown_provider_metadata"]["opaque"],
            true
        );
        let patch = server
            .requests()
            .into_iter()
            .find(|request| request.method == "PATCH")
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&patch.body).unwrap(), json!({"title":"after"}));
        assert_eq!(patch.if_match.as_deref(), Some("\"task-seed-1\""));
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn readonly_import_paginates_complete_inventory_and_never_writes() {
        let (_root, app) = support::host();
        let server = FixtureServer::start(WireFormat::GoogleCalendar, false);
        server.set_page_size(1);
        server.seed(
            "abcde00001",
            calendar_item(
                "abcde00001",
                "all day",
                json!({"date":"2026-11-01"}),
                json!({"date":"2026-11-02"}),
            ),
        );
        server.seed(
            "abcde00002",
            calendar_item(
                "abcde00002",
                "second",
                json!({"dateTime":"2026-11-01T09:00:00-04:00","timeZone":"America/New_York"}),
                json!({"dateTime":"2026-11-01T10:00:00-04:00","timeZone":"America/New_York"}),
            ),
        );
        support::configure_google(
            &app,
            "events",
            WireFormat::GoogleCalendar,
            SyncPhase::ReadOnlyImport,
        )
        .unwrap();
        let import = adapter(
            &server,
            "events",
            WireFormat::GoogleCalendar,
            SyncPhase::ReadOnlyImport,
            LeaseFixture::valid(),
        );
        let pulled = app.planner_pull("events", &import).await.unwrap();
        assert_eq!(pulled["complete"], true);
        assert_eq!(pulled["observed"], 2);
        let all_day = support::resource(&app, "events", "abcde00001").unwrap();
        assert_eq!(
            all_day.view.end_ms.unwrap() - all_day.view.start_ms.unwrap(),
            86_400_000
        );
        assert!(all_day.raw.unwrap().contains("\"date\":\"2026-11-01\""));

        let denied = support::enqueue(
            &app,
            "owner:readonly-denied",
            patch_mutation("events", "abcde00001", all_day.version, "should not write"),
        );
        assert!(denied.is_err());
        let direct = import
            .write_operation(
                ConditionalWrite {
                    uid: "abcde00001".into(),
                    href: "events/abcde00001".into(),
                    raw: Some("{\"summary\":\"denied\"}".into()),
                    condition: Condition::Match("\"calendar-seed-1\"".into()),
                },
                "fixture-readonly-op",
                Some("{\"summary\":\"denied\"}"),
            )
            .await
            .unwrap();
        assert!(matches!(direct, WriteOutcome::NotDispatched));
        let requests = server.requests();
        assert_eq!(requests.iter().filter(|r| r.method == "GET").count(), 2);
        assert!(!requests.iter().any(|r| r.method != "GET"));
        app.shutdown().await.unwrap();
    }

    #[test]
    fn loopback_fixture_constructor_rejects_non_loopback_http() {
        let leases = LeaseFixture::valid();
        assert!(GooglePlannerAdapter::loopback_fixture(
            "fixture",
            "fixture-account",
            "fixture-calendar",
            WireFormat::GoogleCalendar,
            SyncPhase::ReadOnlyImport,
            leases,
            "http://example.invalid/",
            Duration::from_secs(1),
        )
        .is_err());
    }

}
