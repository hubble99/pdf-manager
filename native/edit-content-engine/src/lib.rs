use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

pub mod discovery;
pub mod hit_test;
pub mod identity;
pub mod preflight;
pub mod replacement;
pub mod resource_inspector;
pub mod verification;
pub mod viewport;
pub mod workspace;

pub const REQUEST_SCHEMA: &str = "edit-content-request/v1";
pub const REPLY_SCHEMA: &str = "edit-content-reply/v1";
pub const PREPARATION_SCHEMA: &str = "edit-content-preparation/v1";
pub const PDFIUM_RENDER_VERSION: &str = env!("PDFIUM_RENDER_VERSION");
pub const PDFIUM_BUILD_IDENTITY: &str = env!("PDFIUM_BUILD_IDENTITY");
pub const PDFIUM_LIBRARY_SHA256: &str = env!("PDFIUM_LIBRARY_SHA256");

pub const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_REPLY_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_QUEUE_DEPTH: usize = 2;
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub schema_version: String,
    pub request_id: String,
    pub session_id: String,
    pub command: String,
    pub expected_accepted_revision: Option<u64>,
    pub target_id: Option<String>,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub schema_version: String,
    pub request_id: String,
    pub session_id: String,
    pub status: String,
    pub accepted_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guard_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub result: Value,
}

impl Reply {
    pub fn accepted(request: &Request, revision: u64, result: Value) -> Self {
        Self {
            schema_version: REPLY_SCHEMA.into(),
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            status: "accepted".into(),
            accepted_revision: revision,
            guard_reason: None,
            error: None,
            result,
        }
    }

    pub fn rejected(
        request: &Request,
        revision: u64,
        status: &str,
        reason: &str,
        error: &str,
    ) -> Self {
        Self {
            schema_version: REPLY_SCHEMA.into(),
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            status: status.into(),
            accepted_revision: revision,
            guard_reason: Some(reason.into()),
            error: Some(error.into()),
            result: Value::Null,
        }
    }

    pub fn guard_rejected(request: &Request, revision: u64, reason: &str, result: Value) -> Self {
        Self {
            schema_version: REPLY_SCHEMA.into(),
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            status: "rejected".into(),
            accepted_revision: revision,
            guard_reason: Some(reason.into()),
            error: Some("edit is not eligible under the current safety policy".into()),
            result,
        }
    }

    pub fn unknown(session_id: &str, request_id: &str, revision: u64, error: &str) -> Self {
        Self {
            schema_version: REPLY_SCHEMA.into(),
            request_id: request_id.into(),
            session_id: session_id.into(),
            status: "unknown".into(),
            accepted_revision: revision,
            guard_reason: None,
            error: Some(error.into()),
            result: Value::Null,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationReply {
    pub schema_version: String,
    pub request_id: String,
    pub session_id: String,
    pub status: String,
    pub accepted_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guard_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub result: Value,
}

impl PreparationReply {
    pub fn prepared(request: &Request, revision: u64, result: Value) -> Self {
        Self {
            schema_version: PREPARATION_SCHEMA.into(),
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            status: "prepared".into(),
            accepted_revision: revision,
            guard_reason: None,
            error: None,
            result,
        }
    }

    pub fn rejected(request: &Request, revision: u64, reason: &str) -> Self {
        Self {
            schema_version: PREPARATION_SCHEMA.into(),
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            status: "rejected".into(),
            accepted_revision: revision,
            guard_reason: Some(reason.into()),
            error: Some("candidate preparation was rejected".into()),
            result: Value::Null,
        }
    }

    pub fn unknown(request: &Request, revision: u64, error: &str) -> Self {
        Self {
            schema_version: PREPARATION_SCHEMA.into(),
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            status: "unknown".into(),
            accepted_revision: revision,
            guard_reason: None,
            error: Some(error.into()),
            result: Value::Null,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum WorkerResponse {
    Public(Reply),
    Preparation(PreparationReply),
}

impl WorkerResponse {
    pub fn duplicate(&self) -> Self {
        match self {
            Self::Public(reply) => Self::Public(Reply {
                status: "duplicate".into(),
                result: json!({"originalOutcome": reply.status, "mutationReplayed": false}),
                ..reply.clone()
            }),
            Self::Preparation(reply) => {
                let mut duplicate = reply.clone();
                if let Value::Object(result) = &mut duplicate.result {
                    result.insert("duplicateRequest".into(), Value::Bool(true));
                    result.insert("mutationReplayed".into(), Value::Bool(false));
                }
                Self::Preparation(duplicate)
            }
        }
    }
}

#[derive(Debug)]
pub enum FrameRead {
    End,
    Request(Request),
    Malformed(String),
    Oversized,
}

pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<FrameRead> {
    let mut header = [0_u8; 4];
    let mut read = 0;
    while read < header.len() {
        match reader.read(&mut header[read..])? {
            0 if read == 0 => return Ok(FrameRead::End),
            0 => {
                return Ok(FrameRead::Malformed(
                    "incomplete frame length prefix".into(),
                ))
            }
            count => read += count,
        }
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 {
        return Ok(FrameRead::Malformed("empty request frame".into()));
    }
    if length > MAX_REQUEST_BYTES {
        return Ok(FrameRead::Oversized);
    }
    let mut payload = vec![0_u8; length];
    if reader.read_exact(&mut payload).is_err() {
        return Ok(FrameRead::Malformed("incomplete request frame".into()));
    }
    match serde_json::from_slice(&payload) {
        Ok(request) => Ok(FrameRead::Request(request)),
        Err(_) => Ok(FrameRead::Malformed(
            "request frame is not valid protocol JSON".into(),
        )),
    }
}

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, reply: &T) -> io::Result<()> {
    let payload = serde_json::to_vec(reply)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.len() > MAX_REPLY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "reply frame exceeds configured limit",
        ));
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

pub fn verify_pdfium_library(path: &Path) -> Result<(), String> {
    let metadata = path
        .metadata()
        .map_err(|_| "PDFium library is missing or unreadable".to_string())?;
    if !metadata.is_file() {
        return Err("PDFium library is missing or unreadable".into());
    }
    let mut file =
        File::open(path).map_err(|_| "PDFium library is missing or unreadable".to_string())?;
    let actual =
        sha256_reader(&mut file).map_err(|_| "PDFium library could not be verified".to_string())?;
    if actual != PDFIUM_LIBRARY_SHA256 {
        return Err("PDFium library hash does not match the pinned engine".into());
    }
    Ok(())
}

pub fn sha256_reader<R: Read>(reader: &mut R) -> io::Result<String> {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
        let mut words = [0_u32; 64];
        for (index, chunk) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes(chunk.try_into().unwrap());
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
        for index in 0..64 {
            let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(sum1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = sum0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }

    let mut state = INITIAL;
    let mut tail = Vec::with_capacity(128);
    let mut total_bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total_bytes = total_bytes.wrapping_add(count as u64);
        tail.extend_from_slice(&buffer[..count]);
        let complete = tail.len() / 64 * 64;
        let remainder = tail.split_off(complete);
        for chunk in tail.chunks_exact(64) {
            compress(&mut state, chunk.try_into().unwrap());
        }
        tail = remainder;
    }
    let bit_length = total_bytes.wrapping_mul(8);
    tail.push(0x80);
    while tail.len() % 64 != 56 {
        tail.push(0);
    }
    tail.extend_from_slice(&bit_length.to_be_bytes());
    for chunk in tail.chunks_exact(64) {
        compress(&mut state, chunk.try_into().unwrap());
    }
    Ok(state.iter().map(|word| format!("{word:08x}")).collect())
}

pub fn timeout_for(command: &str) -> Duration {
    match command {
        "open" | "close" => Duration::from_secs(10),
        "inspect" | "history" => Duration::from_secs(30),
        "render" => Duration::from_secs(60),
        "apply" | "save" => Duration::from_secs(120),
        _ => Duration::from_secs(10),
    }
}

pub fn validate_request(
    request: &Request,
    session_id: &str,
) -> Result<(), (&'static str, &'static str)> {
    if request.schema_version != REQUEST_SCHEMA {
        return Err((
            "REJECTED_UNSUPPORTED_STRUCTURE",
            "unsupported request schema",
        ));
    }
    if request.request_id.trim().is_empty() || request.session_id.trim().is_empty() {
        return Err((
            "REJECTED_UNSUPPORTED_STRUCTURE",
            "request and session IDs are required",
        ));
    }
    if request.session_id != session_id {
        return Err(("REJECTED_STALE_REVISION", "request session is not current"));
    }
    let known_command = matches!(
        request.command.as_str(),
        "open" | "inspect" | "render" | "apply" | "history" | "save" | "close"
    );
    if !known_command {
        return Err(("REJECTED_UNSUPPORTED_STRUCTURE", "unsupported command"));
    }
    if request.command != "open" && request.expected_accepted_revision.is_none() {
        return Err((
            "REJECTED_STALE_REVISION",
            "expected accepted revision is required",
        ));
    }
    if request.command == "apply" && request.target_id.as_deref().unwrap_or("").is_empty() {
        return Err((
            "REJECTED_UNSUPPORTED_STRUCTURE",
            "target ID is required for apply",
        ));
    }
    if contains_prohibited_data(&Value::Object(request.payload.clone())) {
        return Err((
            "REJECTED_UNSUPPORTED_STRUCTURE",
            "request contains prohibited private data",
        ));
    }
    Ok(())
}

fn contains_prohibited_data(value: &Value) -> bool {
    const PROHIBITED: [&str; 6] = [
        "nativeHandle",
        "nativeObjectPointer",
        "filesystemPath",
        "sourcePath",
        "candidatePath",
        "fontProgramBytes",
    ];
    match value {
        Value::Object(map) => map.iter().any(|(key, child)| {
            PROHIBITED.contains(&key.as_str()) || contains_prohibited_data(child)
        }),
        Value::Array(values) => values.iter().any(contains_prohibited_data),
        _ => false,
    }
}

pub fn duplicate_reply(request: &Request, revision: u64, original: &Reply) -> Reply {
    Reply {
        schema_version: REPLY_SCHEMA.into(),
        request_id: request.request_id.clone(),
        session_id: request.session_id.clone(),
        status: "duplicate".into(),
        accepted_revision: revision,
        guard_reason: None,
        error: None,
        result: json!({
            "originalOutcome": original.status,
            "mutationReplayed": false,
        }),
    }
}

pub struct RequestLedger {
    outcomes: HashMap<String, Reply>,
}

impl RequestLedger {
    pub fn new() -> Self {
        Self {
            outcomes: HashMap::new(),
        }
    }

    pub fn outcome(&self, request_id: &str) -> Option<&Reply> {
        self.outcomes.get(request_id)
    }

    pub fn remember(&mut self, request_id: String, reply: Reply) {
        self.outcomes.insert(request_id, reply);
    }
}

impl Default for RequestLedger {
    fn default() -> Self {
        Self::new()
    }
}

pub type SharedWriter<W> = Arc<Mutex<W>>;

pub fn send_reply<W: Write>(writer: &SharedWriter<W>, reply: &Reply) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("protocol writer unavailable"))?;
    write_frame(&mut *writer, reply)
}

pub fn send_response<W: Write>(
    writer: &SharedWriter<W>,
    response: &WorkerResponse,
) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("protocol writer unavailable"))?;
    write_frame(&mut *writer, response)
}

pub fn send_backpressure<W: Write>(writer: &SharedWriter<W>, request: &Request, revision: u64) {
    if request.command == "apply" {
        let response = WorkerResponse::Preparation(PreparationReply::unknown(
            request,
            revision,
            "worker queue capacity exceeded",
        ));
        let _ = send_response(writer, &response);
    } else {
        let reply = Reply::unknown(
            &request.session_id,
            &request.request_id,
            revision,
            "worker queue capacity exceeded",
        );
        let _ = send_reply(writer, &reply);
    }
}

pub fn bounded_request_channel() -> (mpsc::SyncSender<Request>, mpsc::Receiver<Request>) {
    mpsc::sync_channel(MAX_QUEUE_DEPTH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn request() -> Request {
        Request {
            schema_version: REQUEST_SCHEMA.into(),
            request_id: "request-1".into(),
            session_id: "session-1".into(),
            command: "open".into(),
            expected_accepted_revision: None,
            target_id: None,
            payload: Map::new(),
        }
    }

    #[test]
    fn frame_round_trip() {
        let reply = Reply::accepted(&request(), 0, json!({"ready": true}));
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &reply).unwrap();
        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(length, bytes.len() - 4);
    }

    #[test]
    fn request_frame_rejects_invalid_json_and_oversize() {
        let mut malformed = Cursor::new([3_u32.to_be_bytes().as_slice(), b"bad"].concat());
        assert!(matches!(
            read_frame(&mut malformed).unwrap(),
            FrameRead::Malformed(_)
        ));
        let mut oversized = Cursor::new(((MAX_REQUEST_BYTES + 1) as u32).to_be_bytes());
        assert!(matches!(
            read_frame(&mut oversized).unwrap(),
            FrameRead::Oversized
        ));
    }

    #[test]
    fn bounded_queue_rejects_a_third_waiting_request() {
        let (sender, _receiver) = bounded_request_channel();
        sender.try_send(request()).unwrap();
        sender.try_send(request()).unwrap();
        assert!(matches!(
            sender.try_send(request()),
            Err(mpsc::TrySendError::Full(_))
        ));
    }

    #[test]
    fn sha256_matches_standard_vectors() {
        assert_eq!(
            sha256_reader(&mut Cursor::new(b"")).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_reader(&mut Cursor::new(b"abc")).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn transport_limits_match_the_frozen_phase_one_policy() {
        assert_eq!(MAX_REQUEST_BYTES, 2_097_152);
        assert_eq!(MAX_REPLY_BYTES, 16_777_216);
        assert_eq!(MAX_QUEUE_DEPTH, 2);
        assert_eq!(STARTUP_TIMEOUT, Duration::from_millis(10_000));
        assert_eq!(timeout_for("inspect"), Duration::from_millis(30_000));
        assert_eq!(timeout_for("render"), Duration::from_millis(60_000));
        assert_eq!(timeout_for("apply"), Duration::from_millis(120_000));
        assert_eq!(timeout_for("save"), Duration::from_millis(120_000));
        assert_eq!(timeout_for("close"), Duration::from_millis(10_000));
    }

    #[test]
    fn oversized_reply_is_rejected_before_writing() {
        let reply = Reply::accepted(&request(), 0, Value::String("x".repeat(MAX_REPLY_BYTES)));
        let mut bytes = Vec::new();
        let error = write_frame(&mut bytes, &reply).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(bytes.is_empty());
    }
}
