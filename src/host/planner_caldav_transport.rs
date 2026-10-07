//! Bounded, credential-free DAV transport. Host binding/permission checks and
//! durable effects stay in planner_sync. No discovery, worker, or TLS bypass.
use super::{
    Adapter, AdapterFuture, Condition, ConditionalWrite, Inventory, RemoteResource, WriteOutcome,
};
use anyhow::{anyhow, bail, Result};
use reqwest::{header, Client, Method, Response, StatusCode, Url};
use roxmltree::{Document, Node, ParsingOptions};
use std::{collections::BTreeSet, time::Duration};

const DAV: &str = "DAV:";
const CALDAV: &str = "urn:ietf:params:xml:ns:caldav";
const PROPFIND: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><D:propfind xmlns:D=\"DAV:\"><D:prop><D:resourcetype/><D:getetag/></D:prop></D:propfind>";
const MAX_XML: usize = 1_048_576;
const MAX_RESOURCE: usize = 1_048_576;
const MAX_TOTAL: usize = 4_194_304;
const MAX_ITEMS: usize = 256;

pub struct HttpAdapter {
    binding: String,
    collection: Url,
    client: Client,
    inventory_timeout: Duration,
}
impl HttpAdapter {
    /// Explicit owner-selected HTTPS collection; credentials remain a future
    /// integration boundary. URLs containing userinfo are never credentials.
    pub fn https(binding: &str, collection: &str) -> Result<Self> {
        Self::build(binding, collection, false, Duration::from_secs(5))
    }
    #[cfg(test)]
    pub(crate) fn loopback_fixture(
        binding: &str,
        collection: &str,
        timeout: Duration,
    ) -> Result<Self> {
        Self::build(binding, collection, true, timeout)
    }
    fn build(binding: &str, input: &str, fixture: bool, timeout: Duration) -> Result<Self> {
        if binding.is_empty() || binding.len() > 1024 || !safe_reference(input) {
            bail!("invalid DAV binding or collection URL");
        }
        let collection = Url::parse(input).map_err(|_| anyhow!("invalid collection URL"))?;
        if !collection.username().is_empty()
            || collection.password().is_some()
            || collection.query().is_some()
            || collection.fragment().is_some()
            || !collection.path().ends_with('/')
            || collection.path() == "/"
            || collection.host_str().is_none()
        {
            bail!("explicit credential-free collection URL required");
        }
        let http_fixture = fixture
            && collection.scheme() == "http"
            && collection
                .host_str()
                .and_then(|h| h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
                .is_some_and(|ip| ip.is_loopback());
        if collection.scheme() != "https" && !http_fixture {
            bail!("HTTPS required; HTTP only allowed by test-only loopback constructor");
        }
        if fixture && !http_fixture {
            bail!("fixture must be literal loopback HTTP");
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
            .map_err(|_| anyhow!("DAV client unavailable"))?;
        Ok(Self {
            binding: binding.into(),
            collection,
            client,
            inventory_timeout: if fixture {
                timeout.saturating_mul(4)
            } else {
                Duration::from_secs(15)
            },
        })
    }
    fn resolve_href(&self, href: &str) -> Result<(Url, Option<String>)> {
        if !safe_reference(href) {
            bail!("unsafe DAV href");
        }
        let url = self
            .collection
            .join(href)
            .map_err(|_| anyhow!("invalid DAV href"))?;
        if url.origin() != self.collection.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("DAV href outside configured origin");
        }
        if url.path() == self.collection.path() {
            return Ok((url, None));
        }
        let leaf = url
            .path()
            .strip_prefix(self.collection.path())
            .filter(|s| super::safe_href(s))
            .ok_or_else(|| anyhow!("DAV href outside direct collection scope"))?
            .to_string();
        Ok((url, Some(leaf)))
    }
    fn resource_url(&self, leaf: &str) -> Result<Url> {
        if !super::safe_href(leaf) {
            bail!("invalid resource locator");
        }
        let (url, actual) = self.resolve_href(leaf)?;
        if actual.as_deref() != Some(leaf) {
            bail!("resource locator changed during resolution");
        }
        Ok(url)
    }
    fn parse_listing(&self, xml: &str) -> Result<Vec<(String, String)>> {
        if xml.len() > MAX_XML || xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") {
            bail!("DAV XML size or DTD prohibited");
        }
        let doc = Document::parse_with_options(
            xml,
            ParsingOptions {
                allow_dtd: false,
                nodes_limit: 16384,
                ..ParsingOptions::default()
            },
        )
        .map_err(|_| anyhow!("invalid DAV XML"))?;
        if !doc.root_element().has_tag_name((DAV, "multistatus"))
            || doc.descendants().any(|n| {
                n.attribute(("http://www.w3.org/XML/1998/namespace", "base"))
                    .is_some()
            })
        {
            bail!("DAV multistatus root required; xml:base prohibited");
        }
        let mut root_seen = false;
        let mut paths = BTreeSet::new();
        let mut listing = Vec::new();
        for response in doc.root_element().children().filter(Node::is_element) {
            if !response.has_tag_name((DAV, "response")) {
                bail!("unexpected DAV multistatus child");
            }
            let href = one_child(response, "href")?;
            let href = text_only(href)?;
            let (_, leaf) = self.resolve_href(href)?;
            let mut etag = None;
            let mut resource_type = None;
            for child in response.children().filter(Node::is_element) {
                if child.has_tag_name((DAV, "href")) {
                    continue;
                }
                if !child.has_tag_name((DAV, "propstat")) {
                    bail!("partial or unsupported DAV response");
                }
                let code = status_code(text_only(one_child(child, "status")?)?)?;
                let props = one_child(child, "prop")?;
                if child
                    .children()
                    .filter(Node::is_element)
                    .any(|n| !n.has_tag_name((DAV, "prop")) && !n.has_tag_name((DAV, "status")))
                    || !props.children().any(|n| n.is_element())
                {
                    bail!("unsupported/empty DAV propstat");
                }
                for property in props.children().filter(Node::is_element) {
                    if property.has_tag_name((DAV, "getetag")) {
                        if leaf.is_none() && code == 404 {
                            continue;
                        }
                        if code != 200 || etag.is_some() {
                            bail!("missing or duplicate DAV ETag");
                        }
                        let value = text_only(property)?;
                        if super::parse_entity_tag(value.as_bytes()).is_none() {
                            bail!("invalid DAV ETag syntax");
                        }
                        etag = Some(value.to_string());
                    } else if property.has_tag_name((DAV, "resourcetype")) {
                        if code != 200 || resource_type.is_some() {
                            bail!("missing or duplicate DAV resource type");
                        }
                        let types = property
                            .children()
                            .filter(Node::is_element)
                            .collect::<Vec<_>>();
                        let calendar = types.len() == 2
                            && types.iter().any(|n| n.has_tag_name((DAV, "collection")))
                            && types.iter().any(|n| n.has_tag_name((CALDAV, "calendar")));
                        if !types.is_empty() && (!calendar || leaf.is_some()) {
                            bail!("unsupported DAV resource type");
                        }
                        resource_type = Some(calendar);
                    } else {
                        bail!("unexpected DAV property; inventory cannot prove completeness");
                    }
                }
            }
            let is_collection =
                resource_type.ok_or_else(|| anyhow!("DAV resource type missing"))?;
            if let Some(leaf) = leaf {
                if is_collection || !paths.insert(leaf.clone()) || listing.len() >= MAX_ITEMS {
                    bail!("nested/duplicate/oversized DAV inventory");
                }
                listing.push((leaf, etag.ok_or_else(|| anyhow!("resource ETag missing"))?));
            } else {
                if !is_collection || root_seen {
                    bail!("invalid/duplicate DAV collection response");
                }
                root_seen = true;
            }
        }
        if !root_seen {
            bail!("DAV collection response absent; no complete inventory");
        }
        Ok(listing)
    }
    async fn get_resource(&self, leaf: &str, expected: &str) -> Result<RemoteResource> {
        let response = self
            .client
            .get(self.resource_url(leaf)?)
            .header(header::ACCEPT, "text/calendar")
            .header(header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| anyhow!("DAV resource read unavailable"))?;
        if response.status() != StatusCode::OK {
            bail!("DAV resource read not confirmed");
        }
        let mut etags = response.headers().get_all(header::ETAG).iter();
        let value = etags
            .next()
            .ok_or_else(|| anyhow!("DAV resource ETag missing"))?;
        if etags.next().is_some() || super::parse_entity_tag(value.as_bytes()).is_none() {
            bail!("DAV resource requires a single valid entity-tag");
        }
        let etag = String::from_utf8(value.as_bytes().to_vec())
            .map_err(|_| anyhow!("DAV ETag cannot be represented in UTF-8 storage"))?;
        if etag != expected {
            bail!("DAV resource changed during inventory; full retry required");
        }
        require_content_type(&response, &["text/calendar"])?;
        let raw = String::from_utf8(read_bounded(response, MAX_RESOURCE).await?)
            .map_err(|_| anyhow!("DAV resource is not UTF-8"))?;
        // GET preserves actual ICS bytes; calendar-data XML can normalize CRLF.
        let uid = super::parse(&raw)
            .uid
            .filter(|u| super::safe_uid(u))
            .ok_or_else(|| anyhow!("DAV resource UID missing/ambiguous"))?;
        Ok(RemoteResource {
            uid,
            href: leaf.into(),
            etag,
            raw,
        })
    }
    async fn full_inventory(&self) -> Result<Inventory> {
        let response = self
            .client
            .request(Method::from_bytes(b"PROPFIND")?, self.collection.clone())
            .header("Depth", "1")
            .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
            .header(header::ACCEPT, "application/xml, text/xml")
            .header(header::ACCEPT_ENCODING, "identity")
            .body(PROPFIND)
            .send()
            .await
            .map_err(|_| anyhow!("DAV inventory unavailable"))?;
        if response.status() != StatusCode::MULTI_STATUS {
            bail!("DAV inventory requires 207; auth/error/redirect is not absence");
        }
        require_content_type(&response, &["application/xml", "text/xml"])?;
        let xml = String::from_utf8(read_bounded(response, MAX_XML).await?)
            .map_err(|_| anyhow!("DAV XML is not UTF-8"))?;
        let mut total = xml.len();
        let mut items = Vec::new();
        let mut uids = BTreeSet::new();
        for (leaf, etag) in self.parse_listing(&xml)? {
            let item = self.get_resource(&leaf, &etag).await?;
            total = total
                .checked_add(item.raw.len())
                .ok_or_else(|| anyhow!("DAV inventory size overflow"))?;
            if total > MAX_TOTAL || !uids.insert(item.uid.clone()) {
                bail!("DAV total size or duplicate UID inventory");
            }
            items.push(item);
        }
        Ok(Inventory {
            complete: true,
            items,
        })
    }
}
impl Adapter for HttpAdapter {
    fn binding(&self) -> &str {
        &self.binding
    }
    fn inventory(&self) -> AdapterFuture<'_, Inventory> {
        Box::pin(async move {
            tokio::time::timeout(self.inventory_timeout, self.full_inventory())
                .await
                .map_err(|_| anyhow!("DAV inventory total timeout"))?
        })
    }
    fn observe_uid<'a>(&'a self, uid: &'a str) -> AdapterFuture<'a, Option<RemoteResource>> {
        Box::pin(async move {
            if !super::safe_uid(uid) {
                bail!("invalid UID observation");
            }
            // Authoritative absence needs a fresh complete collection scan;
            // GET 404 at a prior href alone is never UID absence.
            Ok(self
                .inventory()
                .await?
                .items
                .into_iter()
                .find(|r| r.uid == uid))
        })
    }
    fn write(&self, request: ConditionalWrite) -> AdapterFuture<'_, WriteOutcome> {
        Box::pin(async move {
            if !super::safe_uid(&request.uid) {
                bail!("invalid DAV mutation UID");
            }
            let url = self.resource_url(&request.href)?;
            if let Some(raw) = &request.raw {
                let parsed = super::parse(raw);
                if raw.len() > MAX_RESOURCE
                    || parsed.uid.as_deref() != Some(&request.uid)
                    || !parsed.diagnostic.is_empty()
                {
                    bail!("DAV write requires host-supported single object");
                }
            }
            let method = if request.raw.is_some() {
                Method::PUT
            } else {
                Method::DELETE
            };
            let mut builder = self
                .client
                .request(method, url)
                .header(header::ACCEPT_ENCODING, "identity");
            builder = match request.condition {
                Condition::Absent if request.raw.is_some() => {
                    builder.header(header::IF_NONE_MATCH, "*")
                }
                Condition::Match(etag) if super::etag_valid(&etag) => {
                    builder.header(header::IF_MATCH, etag)
                }
                _ => bail!("strong DAV mutation precondition required"),
            };
            if let Some(raw) = request.raw {
                builder = builder
                    .header(header::CONTENT_TYPE, "text/calendar; charset=utf-8")
                    .body(raw);
            }
            let response = match builder.send().await {
                Ok(r) => r,
                Err(_) => return Ok(WriteOutcome::Uncertain),
            };
            let status = response.status();
            // Bounded drain/drop must not erase an already observed 412.
            // Incomplete 2xx acknowledgements remain uncertain, while 412 is
            // an explicit precondition rejection regardless of its body.
            let body_complete = read_bounded(response, 65536).await.is_ok();
            if status == StatusCode::PRECONDITION_FAILED {
                return Ok(WriteOutcome::PreconditionFailed);
            }
            if !body_complete {
                return Ok(WriteOutcome::Uncertain);
            }
            Ok(match status.as_u16() {
                200 | 201 | 204 => WriteOutcome::Applied,
                _ => WriteOutcome::Uncertain,
            })
        })
    }
}
fn safe_reference(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 4096
        && !s
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '%' | '\\' | '?' | '#'))
        && !s.split('/').any(|segment| matches!(segment, "." | ".."))
}
fn one_child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Result<Node<'a, 'input>> {
    let mut nodes = node.children().filter(|n| n.has_tag_name((DAV, name)));
    let first = nodes
        .next()
        .ok_or_else(|| anyhow!("required DAV XML element missing"))?;
    if nodes.next().is_some() {
        bail!("duplicate DAV XML element");
    }
    Ok(first)
}
fn text_only<'a, 'input>(node: Node<'a, 'input>) -> Result<&'a str> {
    if node.children().any(|n| !n.is_text()) || node.children().count() > 1 {
        bail!("DAV scalar contains split or nested XML");
    }
    Ok(node.text().unwrap_or(""))
}
fn status_code(s: &str) -> Result<u16> {
    let mut fields = s.split_whitespace();
    if !matches!(fields.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
        bail!("invalid DAV status line");
    }
    let code = fields
        .next()
        .filter(|s| s.len() == 3)
        .ok_or_else(|| anyhow!("invalid DAV status code"))?
        .parse::<u16>()?;
    if !(100..600).contains(&code) {
        bail!("invalid DAV status code");
    }
    Ok(code)
}
fn require_content_type(response: &Response, allowed: &[&str]) -> Result<()> {
    let media = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.split(';').next())
        .unwrap_or("")
        .trim();
    if !allowed.iter().any(|a| media.eq_ignore_ascii_case(a)) {
        bail!("unexpected DAV response content type");
    }
    Ok(())
}
async fn read_bounded(mut response: Response, limit: usize) -> Result<Vec<u8>> {
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|v| v.as_bytes() != b"identity")
        || response.content_length().is_some_and(|n| n > limit as u64)
    {
        bail!("DAV response encoding/size limit");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("DAV response truncated or timed out"))?
    {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            bail!("DAV response size limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "planner_caldav_http_fixture.rs"]
pub(crate) mod fixture;
#[cfg(test)]
#[path = "planner_caldav_radicale_tests.rs"]
mod radicale_tests;
#[cfg(test)]
#[path = "planner_caldav_transport_tests.rs"]
mod tests;
