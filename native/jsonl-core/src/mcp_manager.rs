use napi::bindgen_prelude::{Error, Status};
use napi_derive::napi;

const DEFAULT_MAX_PAYLOAD_BYTES: usize = 16 * 1024;
const MAX_MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const MODERN_PROTOCOL_VERSION: &str = "2026-07-28";
const LEGACY_PROTOCOL_VERSION: &str = "2025-06-18";
const TRANSITION_PROTOCOL_VERSION: &str = "2025-11-25";
const CLIENT_NAME: &str = "JsonlView";
const CLIENT_VERSION: &str = "0.2";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum McpManagerState {
    Dormant,
    Connecting,
    Ready,
    AwaitingResponse,
    Failed,
    Closed,
}

impl McpManagerState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Dormant => "dormant",
            Self::Connecting => "connecting",
            Self::Ready => "ready",
            Self::AwaitingResponse => "awaiting-response",
            Self::Failed => "failed",
            Self::Closed => "closed",
        }
    }
}

/// Transport-neutral MCP lifecycle manager. The host owns the actual stdio or
/// HTTP transport and must call these methods only after an explicit user
/// action. Constructing this object does not start a process or open a socket.
#[napi]
pub struct McpManager {
    state: McpManagerState,
    protocol_version: &'static str,
    next_request_id: u64,
    max_payload_bytes: usize,
}

#[napi]
impl McpManager {
    #[napi(constructor)]
    pub fn new(max_payload_bytes: Option<u32>) -> napi::Result<Self> {
        let max_payload_bytes = max_payload_bytes
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_MAX_PAYLOAD_BYTES);
        if !(1024..=MAX_MAX_PAYLOAD_BYTES).contains(&max_payload_bytes) {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "MCP manager payload budget must be between 1024 and {MAX_MAX_PAYLOAD_BYTES} bytes"
                ),
            ));
        }
        Ok(Self {
            state: McpManagerState::Dormant,
            protocol_version: MODERN_PROTOCOL_VERSION,
            next_request_id: 0,
            max_payload_bytes,
        })
    }

    /// Begin the lazy handshake. No transport is acquired by this method.
    #[napi(js_name = "beginConnection")]
    pub fn begin_connection(&mut self) -> napi::Result<String> {
        if !matches!(
            self.state,
            McpManagerState::Dormant | McpManagerState::Failed
        ) {
            return Err(invalid_state("beginConnection", self.state));
        }
        self.protocol_version = MODERN_PROTOCOL_VERSION;
        self.next_request_id = self.next_request_id.saturating_add(1);
        self.state = McpManagerState::Connecting;
        self.bounded(
            format!(
                r#"{{"jsonrpc":"2.0","id":{},"method":"initialize","params":{{"protocolVersion":"{}","capabilities":{{}},"clientInfo":{{"name":"{}","version":"{}"}}}}}}"#,
                self.next_request_id,
                self.protocol_version,
                CLIENT_NAME,
                CLIENT_VERSION
            ),
        )
    }

    /// Accept either the modern or legacy server response.
    #[napi(js_name = "acceptInitialize")]
    pub fn accept_initialize(&mut self, server_protocol_version: String) -> napi::Result<String> {
        if self.state != McpManagerState::Connecting {
            return Err(invalid_state("acceptInitialize", self.state));
        }
        let version = server_protocol_version.trim();
        if version != MODERN_PROTOCOL_VERSION
            && version != LEGACY_PROTOCOL_VERSION
            && version != TRANSITION_PROTOCOL_VERSION
        {
            self.state = McpManagerState::Failed;
            return Err(Error::new(
                Status::InvalidArg,
                format!("unsupported MCP protocol version: {version}"),
            ));
        }
        self.protocol_version = match version {
            MODERN_PROTOCOL_VERSION => MODERN_PROTOCOL_VERSION,
            TRANSITION_PROTOCOL_VERSION => TRANSITION_PROTOCOL_VERSION,
            _ => LEGACY_PROTOCOL_VERSION,
        };
        self.state = McpManagerState::Ready;
        self.bounded(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#.to_string(),
        )
    }

    /// Retry the handshake against an older MCP server after a modern attempt
    /// was rejected by the transport.
    #[napi(js_name = "retryLegacyConnection")]
    pub fn retry_legacy_connection(
        &mut self,
        requested_version: Option<String>,
    ) -> napi::Result<String> {
        if !matches!(self.state, McpManagerState::Failed) {
            return Err(invalid_state("retryLegacyConnection", self.state));
        }
        let requested_version = requested_version
            .as_deref()
            .unwrap_or(LEGACY_PROTOCOL_VERSION);
        if requested_version != LEGACY_PROTOCOL_VERSION
            && requested_version != TRANSITION_PROTOCOL_VERSION
        {
            self.state = McpManagerState::Failed;
            return Err(Error::new(
                Status::InvalidArg,
                format!("unsupported legacy MCP protocol version: {requested_version}"),
            ));
        }
        self.protocol_version = if requested_version == TRANSITION_PROTOCOL_VERSION {
            TRANSITION_PROTOCOL_VERSION
        } else {
            LEGACY_PROTOCOL_VERSION
        };
        self.next_request_id = self.next_request_id.saturating_add(1);
        self.state = McpManagerState::Connecting;
        self.bounded(
            format!(
                r#"{{"jsonrpc":"2.0","id":{},"method":"initialize","params":{{"protocolVersion":"{}","capabilities":{{}},"clientInfo":{{"name":"{}","version":"{}"}}}}}}"#,
                self.next_request_id,
                self.protocol_version,
                CLIENT_NAME,
                CLIENT_VERSION
            ),
        )
    }

    #[napi(js_name = "prepareDiagnostic")]
    pub fn prepare_diagnostic(
        &mut self,
        stage: String,
        name: String,
        message: String,
    ) -> napi::Result<String> {
        if self.state != McpManagerState::Ready {
            return Err(invalid_state("prepareDiagnostic", self.state));
        }
        let stage = bounded_field(&stage, 128);
        let name = bounded_field(&name, 128);
        let message = bounded_field(&message, 512);
        self.next_request_id = self.next_request_id.saturating_add(1);
        let request = format!(
            r#"{{"jsonrpc":"2.0","id":{},"method":"tools/call","params":{{"name":"report_diagnostic","arguments":{{"schema":"jsonlview.side-agent-diagnostic.v1","source":"JsonlView","stage":"{}","error":{{"name":"{}","message":"{}"}},"contentPolicy":"metadata-only","protocolVersion":"{}"}}}}}}"#,
            self.next_request_id,
            escape_json(&stage),
            escape_json(&name),
            escape_json(&message),
            self.protocol_version
        );
        let request = self.bounded(request)?;
        self.state = McpManagerState::AwaitingResponse;
        Ok(request)
    }

    #[napi(js_name = "completeRequest")]
    pub fn complete_request(&mut self) -> napi::Result<()> {
        if self.state != McpManagerState::AwaitingResponse {
            return Err(invalid_state("completeRequest", self.state));
        }
        self.state = McpManagerState::Ready;
        Ok(())
    }

    #[napi(js_name = "failRequest")]
    pub fn fail_request(&mut self) {
        if self.state != McpManagerState::Closed {
            self.state = McpManagerState::Failed;
        }
    }

    #[napi]
    pub fn close(&mut self) {
        self.state = McpManagerState::Closed;
    }

    #[napi]
    pub fn state(&self) -> String {
        self.state.as_str().to_string()
    }

    #[napi(js_name = "protocolVersion")]
    pub fn protocol_version(&self) -> String {
        self.protocol_version.to_string()
    }

    fn bounded(&self, value: String) -> napi::Result<String> {
        if value.len() > self.max_payload_bytes {
            return Err(Error::new(
                Status::InvalidArg,
                "MCP manager payload exceeds the configured byte budget",
            ));
        }
        Ok(value)
    }
}

fn invalid_state(operation: &str, state: McpManagerState) -> Error {
    Error::new(
        Status::InvalidArg,
        format!(
            "MCP manager cannot {operation} while state is {}",
            state.as_str()
        ),
    )
}

fn bounded_field(value: &str, max_chars: usize) -> String {
    let sanitized: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect();
    if sanitized.is_empty() {
        "Unknown".to_string()
    } else {
        sanitized
    }
}

fn escape_json(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0c}' => escaped.push_str("\\f"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write;
                let _ = write!(escaped, "\\u{:04x}", character as u32);
            }
            character => escaped.push(character),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remains_dormant_until_an_explicit_connection_attempt() {
        let manager = McpManager::new(None).expect("valid defaults");
        assert_eq!(manager.state, McpManagerState::Dormant);
    }

    #[test]
    fn accepts_modern_and_legacy_initialize_responses() {
        let mut manager = McpManager::new(None).expect("valid defaults");
        let initialize = manager.begin_connection().expect("modern initialize");
        assert!(initialize.contains(MODERN_PROTOCOL_VERSION));
        let initialized = manager
            .accept_initialize(LEGACY_PROTOCOL_VERSION.to_string())
            .expect("legacy response");
        assert!(initialized.contains("notifications/initialized"));
        assert_eq!(manager.protocol_version, LEGACY_PROTOCOL_VERSION);
    }

    #[test]
    fn retries_legacy_after_modern_handshake_failure() {
        let mut manager = McpManager::new(None).expect("valid defaults");
        manager.begin_connection().expect("modern initialize");
        manager.fail_request();
        let retry = manager
            .retry_legacy_connection(Some(TRANSITION_PROTOCOL_VERSION.to_string()))
            .expect("legacy initialize");
        assert!(retry.contains(TRANSITION_PROTOCOL_VERSION));
        assert_eq!(manager.state, McpManagerState::Connecting);
    }

    #[test]
    fn builds_bounded_metadata_only_tool_call() {
        let mut manager = McpManager::new(None).expect("valid defaults");
        manager.begin_connection().expect("initialize");
        manager
            .accept_initialize(MODERN_PROTOCOL_VERSION.to_string())
            .expect("initialized");
        let request = manager
            .prepare_diagnostic(
                "webview_diagnostic".to_string(),
                "Error".to_string(),
                "quote \" and newline\n".to_string(),
            )
            .expect("tool call");
        assert!(request.contains("tools/call"));
        assert!(request.contains("metadata-only"));
        assert!(request.contains("quote \\\" and newline"));
        assert_eq!(manager.state, McpManagerState::AwaitingResponse);
    }

    #[test]
    fn rejects_unknown_server_protocol_and_closes_failed_requests() {
        let mut manager = McpManager::new(None).expect("valid defaults");
        manager.begin_connection().expect("initialize");
        assert!(manager.accept_initialize("1999-01-01".to_string()).is_err());
        assert_eq!(manager.state, McpManagerState::Failed);
        manager.close();
        assert_eq!(manager.state, McpManagerState::Closed);
    }
}
