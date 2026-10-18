use std::fs::{File, Metadata};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::UNIX_EPOCH;

use memchr::memchr;
use napi::bindgen_prelude::{Error, Status};
use napi_derive::napi;

const DEFAULT_QUERY_LIMIT: u32 = 100;
const MAX_QUERY_LIMIT: u32 = 4096;
const DEFAULT_QUERY_BYTES: u32 = 1024 * 1024;
const MAX_QUERY_BYTES: u32 = 8 * 1024 * 1024;
const MAX_QUERY_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_SOURCE_PATH_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueryError {
    InvalidSourcePath,
    InvalidStartOrdinal,
    StartOrdinalTooLarge,
    LimitTooLarge,
    MaxBytesTooLarge,
    SourceOpenFailed,
    SourceMetadataFailed,
    ReadFailed,
    ScanBudgetExceeded,
    RecordTooLarge,
    InvalidUtf8,
    ResponseTooLarge,
}

impl QueryError {
    const fn code(self) -> &'static str {
        match self {
            Self::InvalidSourcePath => "invalid-source-path",
            Self::InvalidStartOrdinal => "invalid-start-ordinal",
            Self::StartOrdinalTooLarge => "start-ordinal-too-large",
            Self::LimitTooLarge => "limit-too-large",
            Self::MaxBytesTooLarge => "max-bytes-too-large",
            Self::SourceOpenFailed => "source-open-failed",
            Self::SourceMetadataFailed => "source-metadata-failed",
            Self::ReadFailed => "read-failed",
            Self::ScanBudgetExceeded => "scan-budget-exceeded",
            Self::RecordTooLarge => "record-too-large",
            Self::InvalidUtf8 => "invalid-utf8",
            Self::ResponseTooLarge => "response-too-large",
        }
    }

    const fn status(self) -> Status {
        match self {
            Self::InvalidSourcePath
            | Self::InvalidStartOrdinal
            | Self::StartOrdinalTooLarge
            | Self::LimitTooLarge
            | Self::MaxBytesTooLarge => Status::InvalidArg,
            Self::SourceOpenFailed
            | Self::SourceMetadataFailed
            | Self::ReadFailed
            | Self::ScanBudgetExceeded
            | Self::RecordTooLarge
            | Self::InvalidUtf8
            | Self::ResponseTooLarge => Status::GenericFailure,
        }
    }

    fn into_napi_error(self) -> Error {
        Error::new(self.status(), format!("jsonl-query:{}", self.code()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct QuerySnapshot {
    size_bytes: u64,
    modified_unix_millis: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QueryRecord {
    ordinal: u64,
    start_byte: u64,
    end_byte: u64,
    raw: String,
}

#[derive(Debug, PartialEq, Eq)]
struct QueryPage {
    snapshot: QuerySnapshot,
    records: Vec<QueryRecord>,
    next_ordinal: Option<u64>,
    truncated: bool,
    truncation_reason: Option<&'static str>,
}

#[napi(js_name = "queryRecords")]
pub fn query_records(
    source_path: String,
    start_ordinal: Option<String>,
    limit: Option<u32>,
    max_bytes: Option<u32>,
) -> napi::Result<String> {
    query_file(
        &source_path,
        start_ordinal.as_deref().unwrap_or("0"),
        limit.unwrap_or(DEFAULT_QUERY_LIMIT),
        max_bytes.unwrap_or(DEFAULT_QUERY_BYTES),
    )
    .map_err(QueryError::into_napi_error)
}

/// Compatibility alias for callers that use the query operation name rather
/// than the record-page name. Both methods share the same bounded contract.
#[napi(js_name = "queryJsonl")]
pub fn query_jsonl(
    source_path: String,
    start_ordinal: Option<String>,
    limit: Option<u32>,
    max_bytes: Option<u32>,
) -> napi::Result<String> {
    query_records(source_path, start_ordinal, limit, max_bytes)
}

fn query_file(
    source_path: &str,
    start_ordinal: &str,
    limit: u32,
    max_bytes: u32,
) -> Result<String, QueryError> {
    if source_path.is_empty() || source_path.len() > MAX_SOURCE_PATH_BYTES {
        return Err(QueryError::InvalidSourcePath);
    }
    let start_ordinal = parse_start_ordinal(start_ordinal)?;
    validate_budget(limit, max_bytes)?;

    let file = File::open(Path::new(source_path)).map_err(|_| QueryError::SourceOpenFailed)?;
    let metadata = file
        .metadata()
        .map_err(|_| QueryError::SourceMetadataFailed)?;
    let snapshot = snapshot_from_metadata(&metadata);
    let page = query_reader(
        BufReader::new(file),
        snapshot,
        start_ordinal,
        limit,
        max_bytes as usize,
    )?;
    serialize_page(&page)
}

fn parse_start_ordinal(value: &str) -> Result<u64, QueryError> {
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) {
        return Err(QueryError::InvalidStartOrdinal);
    }
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(QueryError::InvalidStartOrdinal);
    }
    let ordinal = value
        .parse::<u64>()
        .map_err(|_| QueryError::StartOrdinalTooLarge)?;
    if ordinal > usize::MAX as u64 {
        return Err(QueryError::StartOrdinalTooLarge);
    }
    Ok(ordinal)
}

fn validate_budget(limit: u32, max_bytes: u32) -> Result<(), QueryError> {
    if limit == 0 || limit > MAX_QUERY_LIMIT {
        return Err(QueryError::LimitTooLarge);
    }
    if max_bytes == 0 || max_bytes > MAX_QUERY_BYTES {
        return Err(QueryError::MaxBytesTooLarge);
    }
    Ok(())
}

fn snapshot_from_metadata(metadata: &Metadata) -> QuerySnapshot {
    let modified_unix_millis = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    QuerySnapshot {
        size_bytes: metadata.len(),
        modified_unix_millis,
    }
}

fn query_reader<R: BufRead>(
    mut reader: R,
    snapshot: QuerySnapshot,
    start_ordinal: u64,
    limit: u32,
    max_bytes: usize,
) -> Result<QueryPage, QueryError> {
    let mut line = Vec::with_capacity(4096);
    let mut ordinal = 0_u64;
    let mut offset = 0_u64;
    let mut returned_bytes = 0_usize;
    let mut records = Vec::with_capacity(limit as usize);
    let mut truncated = false;
    let mut truncation_reason = None;

    while records.len() < limit as usize {
        line.clear();
        let Some(line_len) = read_line_bounded(&mut reader, &mut line)? else {
            break;
        };
        let line_end = offset
            .checked_add(line_len as u64)
            .ok_or(QueryError::ScanBudgetExceeded)?;
        if ordinal < start_ordinal && line_end > MAX_QUERY_SCAN_BYTES {
            return Err(QueryError::ScanBudgetExceeded);
        }

        let content_len = content_length(&line);
        let content = &line[..content_len];
        let start_byte = offset;
        let end_byte = start_byte
            .checked_add(content_len as u64)
            .ok_or(QueryError::ScanBudgetExceeded)?;
        offset = line_end;

        if ordinal < start_ordinal {
            ordinal = ordinal.saturating_add(1);
            continue;
        }

        let raw = std::str::from_utf8(content)
            .map_err(|_| QueryError::InvalidUtf8)?
            .to_owned();
        if returned_bytes.saturating_add(content.len()) > max_bytes {
            truncated = true;
            truncation_reason = Some("max-bytes");
            break;
        }
        returned_bytes = returned_bytes.saturating_add(content.len());
        records.push(QueryRecord {
            ordinal,
            start_byte,
            end_byte,
            raw,
        });
        ordinal = ordinal.saturating_add(1);
    }

    if !truncated
        && records.len() == limit as usize
        && !reader
            .fill_buf()
            .map_err(|_| QueryError::ReadFailed)?
            .is_empty()
    {
        truncated = true;
        truncation_reason = Some("page-limit");
    }

    Ok(QueryPage {
        snapshot,
        records,
        next_ordinal: if truncated { Some(ordinal) } else { None },
        truncated,
        truncation_reason,
    })
}

fn read_line_bounded<R: BufRead>(
    reader: &mut R,
    output: &mut Vec<u8>,
) -> Result<Option<usize>, QueryError> {
    loop {
        let buffer = reader.fill_buf().map_err(|_| QueryError::ReadFailed)?;
        if buffer.is_empty() {
            return if output.is_empty() {
                Ok(None)
            } else {
                Ok(Some(output.len()))
            };
        }
        let take = memchr(b'\n', buffer).map_or(buffer.len(), |position| position + 1);
        if output.len().saturating_add(take) > MAX_RECORD_BYTES {
            return Err(QueryError::RecordTooLarge);
        }
        let ends_with_lf = buffer[take - 1] == b'\n';
        output.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if ends_with_lf {
            return Ok(Some(output.len()));
        }
    }
}

fn content_length(line: &[u8]) -> usize {
    let without_lf = line.strip_suffix(b"\n").unwrap_or(line);
    without_lf
        .strip_suffix(b"\r")
        .map_or(without_lf.len(), |value| value.len())
}

fn serialize_page(page: &QueryPage) -> Result<String, QueryError> {
    let mut output = String::with_capacity(1024);
    output.push_str(r#"{"schema":"jsonlview.rust-query.v1","snapshot":{"sizeBytes":""#);
    output.push_str(&page.snapshot.size_bytes.to_string());
    output.push_str(r#"","modifiedUnixMillis":""#);
    output.push_str(&page.snapshot.modified_unix_millis.to_string());
    output.push_str(r#""},"records":["#);
    for (index, record) in page.records.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(r#"{"ordinal":""#);
        output.push_str(&record.ordinal.to_string());
        output.push_str(r#"","startByte":""#);
        output.push_str(&record.start_byte.to_string());
        output.push_str(r#"","endByte":""#);
        output.push_str(&record.end_byte.to_string());
        output.push_str(r#"","raw":""#);
        escape_json_string(&mut output, &record.raw);
        output.push_str(r#""}"#);
    }
    output.push_str(r#"],"nextOrdinal":"#);
    match page.next_ordinal {
        Some(next) => {
            output.push('"');
            output.push_str(&next.to_string());
            output.push('"');
        }
        None => output.push_str("null"),
    }
    output.push_str(r#","truncated":"#);
    output.push_str(if page.truncated { "true" } else { "false" });
    output.push_str(r#","truncationReason":"#);
    match page.truncation_reason {
        Some(reason) => {
            output.push('"');
            output.push_str(reason);
            output.push('"');
        }
        None => output.push_str("null"),
    }
    output.push('}');
    if output.len() > MAX_QUERY_BYTES as usize * 4 {
        return Err(QueryError::ResponseTooLarge);
    }
    Ok(output)
}

fn escape_json_string(output: &mut String, value: &str) {
    for character in value.chars() {
        match character {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write;
                let _ = write!(output, "\\u{:04x}", character as u32);
            }
            character => output.push(character),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn snapshot() -> QuerySnapshot {
        QuerySnapshot {
            size_bytes: 42,
            modified_unix_millis: 1000,
        }
    }

    #[test]
    fn returns_bounded_records_with_absolute_offsets_and_decimal_cursors() {
        let input = b"{\"a\":1}\r\n{\"a\":2}\n{\"a\":3}";
        let page = query_reader(Cursor::new(input), snapshot(), 1, 1, 1024).expect("query page");
        assert_eq!(page.records.len(), 1);
        assert_eq!(page.records[0].ordinal, 1);
        assert_eq!(page.records[0].start_byte, 9);
        assert_eq!(page.records[0].end_byte, 16);
        assert_eq!(page.records[0].raw, "{\"a\":2}");
        assert_eq!(page.next_ordinal, Some(2));
        assert_eq!(page.truncation_reason, Some("page-limit"));
    }

    #[test]
    fn stops_before_a_record_that_would_exceed_the_byte_budget() {
        let page = query_reader(Cursor::new(b"one\ntwo\nthree"), snapshot(), 0, 10, 6)
            .expect("query page");
        assert_eq!(
            page.records
                .iter()
                .map(|record| record.raw.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        assert_eq!(page.next_ordinal, Some(2));
        assert_eq!(page.truncation_reason, Some("max-bytes"));
    }

    #[test]
    fn preserves_blank_lines_and_a_partial_final_record() {
        let page =
            query_reader(Cursor::new(b"\nlast"), snapshot(), 0, 10, 1024).expect("query page");
        assert_eq!(page.records[0].raw, "");
        assert_eq!(page.records[1].raw, "last");
        assert!(!page.truncated);
        assert_eq!(page.next_ordinal, None);
    }

    #[test]
    fn rejects_invalid_utf8_instead_of_rewriting_source_bytes() {
        let error = query_reader(Cursor::new(vec![0xff, b'\n']), snapshot(), 0, 1, 1024)
            .expect_err("invalid UTF-8 must fail closed");
        assert_eq!(error, QueryError::InvalidUtf8);
    }

    #[test]
    fn validates_decimal_start_ordinals_and_budgets() {
        assert_eq!(parse_start_ordinal("0"), Ok(0));
        assert_eq!(parse_start_ordinal("12"), Ok(12));
        assert_eq!(
            parse_start_ordinal("01"),
            Err(QueryError::InvalidStartOrdinal)
        );
        assert_eq!(
            parse_start_ordinal("-1"),
            Err(QueryError::InvalidStartOrdinal)
        );
        assert_eq!(validate_budget(0, 1), Err(QueryError::LimitTooLarge));
        assert_eq!(validate_budget(1, 0), Err(QueryError::MaxBytesTooLarge));
        assert_eq!(
            validate_budget(MAX_QUERY_LIMIT + 1, 1),
            Err(QueryError::LimitTooLarge)
        );
    }

    #[test]
    fn serializes_the_versioned_page_contract() {
        let page = query_reader(Cursor::new(b"{\"ok\":true}\n"), snapshot(), 0, 10, 1024)
            .expect("query page");
        let serialized = serialize_page(&page).expect("json response");
        assert!(serialized.contains("\"schema\":\"jsonlview.rust-query.v1\""));
        assert!(serialized.contains("\"sizeBytes\":\"42\""));
        assert!(serialized.contains("\"ordinal\":\"0\""));
    }
}
