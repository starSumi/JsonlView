use memchr::memchr_iter;
use napi::bindgen_prelude::{Error, Status, Uint8Array, Uint32Array};
use napi_derive::napi;

pub const ABI_VERSION: u32 = 2;
pub const CAPABILITY_SCAN_LF: u32 = 1 << 0;
pub const MAX_SCAN_OFFSETS: u32 = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ScanError {
    InputTooLarge,
    StartOutOfRange,
    LimitTooLarge,
}

pub fn validate_scan_limit(limit: u32) -> std::result::Result<usize, ScanError> {
    if limit > MAX_SCAN_OFFSETS {
        return Err(ScanError::LimitTooLarge);
    }
    Ok(limit as usize)
}

pub fn scan_lf_into_core(
    input: &[u8],
    start: usize,
    output: &mut [u32],
) -> std::result::Result<usize, ScanError> {
    if input.len() > u32::MAX as usize {
        return Err(ScanError::InputTooLarge);
    }
    if start > input.len() {
        return Err(ScanError::StartOutOfRange);
    }

    let mut written = 0;
    for relative in memchr_iter(b'\n', &input[start..]).take(output.len()) {
        output[written] = u32::try_from(start + relative).map_err(|_| ScanError::InputTooLarge)?;
        written += 1;
    }
    Ok(written)
}

#[napi(js_name = "abiVersion")]
pub fn abi_version() -> u32 {
    ABI_VERSION
}

#[napi]
pub fn capabilities() -> u32 {
    CAPABILITY_SCAN_LF
}

#[napi(js_name = "scanLf")]
pub fn scan_lf(input: Uint8Array, start: u32, limit: u32) -> napi::Result<Uint32Array> {
    let limit = validate_scan_limit(limit).map_err(|_| {
        Error::new(
            Status::InvalidArg,
            "limit exceeds the bounded scanner output",
        )
    })?;
    if input.len() > u32::MAX as usize {
        return Err(Error::new(
            Status::InvalidArg,
            "input exceeds the u32 offset domain",
        ));
    }
    if start as usize > input.len() {
        return Err(Error::new(Status::InvalidArg, "start is outside the input"));
    }
    let mut offsets = Vec::with_capacity(limit);
    for relative in memchr_iter(b'\n', &input[start as usize..]).take(limit) {
        offsets.push(
            u32::try_from(start as usize + relative).map_err(|_| {
                Error::new(Status::InvalidArg, "input exceeds the u32 offset domain")
            })?,
        );
    }
    Ok(Uint32Array::from(offsets))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_a_bounded_output_and_resumes_after_the_last_offset() {
        let input = b"a\nb\nc\nd\n";
        let mut first = [0_u32; 2];
        assert_eq!(scan_lf_into_core(input, 0, &mut first), Ok(2));
        assert_eq!(first, [1, 3]);

        let mut second = [0_u32; 2];
        assert_eq!(
            scan_lf_into_core(input, first[1] as usize + 1, &mut second),
            Ok(2)
        );
        assert_eq!(second, [5, 7]);

        let mut exhausted = [99_u32; 2];
        assert_eq!(
            scan_lf_into_core(input, second[1] as usize + 1, &mut exhausted),
            Ok(0)
        );
        assert_eq!(exhausted, [99, 99]);
    }

    #[test]
    fn treats_crlf_as_bytes_and_reports_only_lf_positions() {
        let mut output = [0_u32; 4];
        let count = scan_lf_into_core(b"{}\r\n\nlast", 0, &mut output).expect("bounded input");
        assert_eq!(count, 2);
        assert_eq!(&output[..count], &[3, 4]);
    }

    #[test]
    fn validates_start_and_handles_empty_output() {
        assert_eq!(
            scan_lf_into_core(b"x", 2, &mut [0]),
            Err(ScanError::StartOutOfRange)
        );
        assert_eq!(scan_lf_into_core(b"x\n", 0, &mut []), Ok(0));
        assert_eq!(scan_lf_into_core(b"", 0, &mut [0]), Ok(0));
    }

    #[test]
    fn caps_the_native_output_budget() {
        assert_eq!(
            validate_scan_limit(MAX_SCAN_OFFSETS),
            Ok(MAX_SCAN_OFFSETS as usize)
        );
        assert_eq!(
            validate_scan_limit(MAX_SCAN_OFFSETS + 1),
            Err(ScanError::LimitTooLarge)
        );
    }
}
