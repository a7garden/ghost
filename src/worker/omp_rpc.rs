use anyhow::{bail, ensure, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};
use std::io::Write;

pub(crate) const MAX_PHYSICAL_FRAME_BYTES: usize = 1_048_576;
pub(crate) const MAX_REASSEMBLED_FRAME_BYTES: usize = MAX_PHYSICAL_FRAME_BYTES;
const MAX_CHUNK_COUNT: usize = 1024;

#[derive(Debug)]
struct ChunkAssembly {
    id: String,
    count: usize,
    byte_length: usize,
    next_index: usize,
    bytes: Vec<u8>,
}

/// Decoder for the pinned OMP stdio JSONL protocol. OMP is not JSON-RPC 2.0.
pub(crate) struct FrameDecoder {
    max_frame_bytes: usize,
    max_reassembled_bytes: usize,
    protocol_version: u64,
    chunks: Option<ChunkAssembly>,
}

impl FrameDecoder {
    pub(crate) fn new() -> Self {
        Self {
            max_frame_bytes: MAX_PHYSICAL_FRAME_BYTES,
            max_reassembled_bytes: MAX_REASSEMBLED_FRAME_BYTES,
            protocol_version: 1,
            chunks: None,
        }
    }

    pub(crate) fn configure_ready(&mut self, frame: &Value) -> Result<bool> {
        ensure!(frame["type"] == "ready", "OMP did not begin with a ready frame");
        ensure!(frame["protocolVersion"] == 1, "unsupported OMP RPC base protocol");
        let supported = frame["supportedProtocolVersions"]
            .as_array()
            .context("OMP ready frame omitted supportedProtocolVersions")?;
        ensure!(supported.iter().any(|value| value.as_u64() == Some(1)), "OMP does not support RPC protocol v1");
        let frame_bytes = frame["maxFrameBytes"]
            .as_u64()
            .context("OMP ready frame omitted maxFrameBytes")? as usize;
        ensure!(frame_bytes >= 128 && frame_bytes <= MAX_PHYSICAL_FRAME_BYTES, "OMP advertised an unsupported physical frame limit");
        let reassembled = frame["maxReassembledFrameBytes"]
            .as_u64()
            .context("OMP ready frame omitted maxReassembledFrameBytes")? as usize;
        ensure!(reassembled >= frame_bytes, "OMP advertised an invalid reassembly limit");
        self.max_frame_bytes = frame_bytes;
        self.max_reassembled_bytes = reassembled.min(MAX_REASSEMBLED_FRAME_BYTES);
        Ok(supported.iter().any(|value| value.as_u64() == Some(2)))
    }

    pub(crate) fn max_frame_bytes(&self) -> usize {
        self.max_frame_bytes
    }

    pub(crate) fn enable_v2(&mut self) {
        self.protocol_version = 2;
    }

    pub(crate) fn decode_line(&mut self, bytes: &[u8]) -> Result<Option<Value>> {
        ensure!(!bytes.is_empty(), "OMP emitted an empty frame");
        ensure!(bytes.len() <= self.max_frame_bytes, "OMP physical frame exceeded the negotiated limit");
        ensure!(bytes.last() == Some(&b'\n'), "OMP stdout ended with a partial JSONL frame");
        let frame: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).context("OMP emitted invalid JSON")?;
        ensure!(frame.is_object(), "OMP frame must be a JSON object");
        if frame["type"] != "rpc_chunk" {
            ensure!(self.chunks.is_none(), "OMP interleaved a frame into an incomplete rpc_chunk sequence");
            return Ok(Some(frame));
        }
        ensure!(self.protocol_version == 2, "OMP sent rpc_chunk before v2 negotiation");
        let id = frame["chunkId"].as_str().context("OMP chunk omitted chunkId")?;
        let index = frame["index"].as_u64().context("OMP chunk omitted index")? as usize;
        let count = frame["count"].as_u64().context("OMP chunk omitted count")? as usize;
        let byte_length = frame["byteLength"].as_u64().context("OMP chunk omitted byteLength")? as usize;
        let data = frame["data"].as_str().context("OMP chunk omitted data")?;
        ensure!(!id.is_empty(), "OMP chunk id is empty");
        ensure!(count > 0 && count <= MAX_CHUNK_COUNT && index < count, "OMP chunk index/count is invalid");
        ensure!(byte_length > 0 && byte_length <= self.max_reassembled_bytes, "OMP logical frame exceeds the negotiated reassembly limit");

        if self.chunks.is_none() {
            ensure!(index == 0, "OMP chunk sequence did not start at index zero");
            self.chunks = Some(ChunkAssembly {
                id: id.to_owned(),
                count,
                byte_length,
                next_index: 0,
                bytes: Vec::with_capacity(byte_length.min(1024 * 1024)),
            });
        }
        let assembly = self.chunks.as_mut().expect("chunk assembly initialized");
        ensure!(assembly.id == id && assembly.count == count && assembly.byte_length == byte_length, "OMP changed chunk sequence metadata");
        ensure!(index == assembly.next_index, "OMP chunks are missing, repeated, or out of order");
        let decoded = BASE64.decode(data).context("OMP chunk data is invalid base64")?;
        ensure!(assembly.bytes.len().saturating_add(decoded.len()) <= assembly.byte_length, "OMP chunks exceed byteLength");
        assembly.bytes.extend_from_slice(&decoded);
        assembly.next_index += 1;
        if assembly.next_index != assembly.count {
            return Ok(None);
        }
        let assembly = self.chunks.take().expect("completed chunk assembly exists");
        ensure!(assembly.bytes.len() == assembly.byte_length, "OMP chunk sequence byteLength mismatch");
        let text = std::str::from_utf8(&assembly.bytes).context("OMP reassembled frame is not UTF-8")?;
        let logical: Value = serde_json::from_str(text).context("OMP reassembled frame is invalid JSON")?;
        ensure!(logical.is_object(), "OMP reassembled frame must be a JSON object");
        Ok(Some(logical))
    }
}

pub(crate) fn write_command<W: Write>(writer: &mut W, command: &Value, max_frame_bytes: usize) -> Result<()> {
    write_frame(writer, command, max_frame_bytes, "OMP RPC command")
}

pub(crate) fn write_frame<W: Write>(writer: &mut W, frame: &Value, max_frame_bytes: usize, label: &str) -> Result<()> {
    let mut bytes = serde_json::to_vec(frame)?;
    bytes.push(b'\n');
    ensure!(bytes.len() <= max_frame_bytes, "{label} exceeds the negotiated physical frame limit");
    writer.write_all(&bytes).context("writing OMP RPC frame")?;
    writer.flush().context("flushing OMP RPC frame")?;
    Ok(())
}

pub(crate) fn scoped_host_tools() -> Value {
    json!([
        {
            "name":"canary_read",
            "label":"Read scoped canary file",
            "description":"Read one UTF-8 file under the assigned worker workspace.",
            "parameters":{
                "type":"object",
                "properties":{"path":{"type":"string","maxLength":4096}},
                "required":["path"],
                "additionalProperties":false
            },
            "loadMode":"always",
            "readsSkillUris":false
        },
        {
            "name":"canary_write",
            "label":"Write scoped canary file",
            "description":"Atomically write one UTF-8 file under the assigned worker workspace.",
            "parameters":{
                "type":"object",
                "properties":{
                    "path":{"type":"string","maxLength":4096},
                    "content":{"type":"string","maxLength":65536}
                },
                "required":["path","content"],
                "additionalProperties":false
            },
            "loadMode":"always",
            "readsSkillUris":false
        }
    ])
}
pub(crate) fn native_host_tools(browser_enabled: bool) -> Value {
    let mut tools = json!([{
        "name":"publish_artifact",
        "label":"Publish workspace artifact",
        "description":"Collect one raw file from the current execution workspace into its immutable local artifact store. Use a workspace-relative path such as output.txt or reports/output.txt, never /workspace/... or a Host absolute path. Native filesystem tools may use different path conventions.",
        "parameters":{
            "type":"object",
            "properties":{"path":{"type":"string","minLength":1,"maxLength":4096,"pattern":"^[^/]","description":"Existing file's workspace-relative path; no absolute path or parent traversal."}},
            "required":["path"],
            "additionalProperties":false
        },
        "loadMode":"always",
        "readsSkillUris":false
    }]);
    if browser_enabled {
        tools.as_array_mut().expect("native host tools are an array").push(json!({
            "name":"browser",
            "label":"Read web pages",
            "description":"Navigate and read public web pages with the Ghost-owned browser profile. Observation only: navigation and reading; no clicks, typing, keys, or scrolls.",
            "parameters":{
                "type":"object",
                "properties":{
                    "operation":{"type":"string","enum":["navigate","read","snapshot","screenshot"]},
                    "url":{"type":"string","maxLength":2048}
                },
                "required":["operation"],
                "additionalProperties":false
            },
            "loadMode":"always",
            "readsSkillUris":false
        }));
    }
    tools
}


pub(crate) fn command(id: &str, method: &str, fields: Value) -> Value {
    let mut object = fields.as_object().cloned().unwrap_or_default();
    object.insert("id".into(), json!(id));
    object.insert("type".into(), json!(method));
    Value::Object(object)
}

pub(crate) fn response_success(frame: &Value, id: &str, method: &str) -> Result<()> {
    ensure!(frame["type"] == "response", "OMP RPC response has an invalid type");
    ensure!(frame["id"].as_str() == Some(id), "OMP RPC response id did not match");
    ensure!(frame["command"].as_str() == Some(method), "OMP RPC response command did not match");
    if frame["success"] != true {
        bail!("OMP rejected RPC command {method}");
    }
    Ok(())
}

pub(crate) fn is_response_for(frame: &Value, id: &str) -> bool {
    frame["type"] == "response" && frame["id"].as_str() == Some(id)
}
