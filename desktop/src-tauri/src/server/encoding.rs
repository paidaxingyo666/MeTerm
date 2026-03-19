//! Character encoding conversion — mirrors Go session encoding logic.
//!
//! Supports: GBK, Big5, EUC-JP, EUC-KR, ISO-8859-1 (via encoding_rs).

use encoding_rs::Encoding;

/// Look up an encoding by name (case-insensitive).
/// Returns the encoding and its canonical name, or None if unsupported.
pub fn lookup_encoding(name: &str) -> Option<&'static Encoding> {
    let lower = name.to_lowercase();
    match lower.as_str() {
        "gbk" | "gb2312" | "cp936" => Some(encoding_rs::GBK),
        "gb18030" => Some(encoding_rs::GB18030),
        "big5" | "cp950" => Some(encoding_rs::BIG5),
        "euc-jp" | "eucjp" => Some(encoding_rs::EUC_JP),
        "euc-kr" | "euckr" | "cp949" => Some(encoding_rs::EUC_KR),
        "iso-8859-1" | "latin1" | "cp1252" => Some(encoding_rs::WINDOWS_1252),
        "utf-8" | "utf8" | "" => None, // native, no conversion needed
        _ => Encoding::for_label(name.as_bytes()),
    }
}

/// Encode UTF-8 string to target encoding.
pub fn encode_to(data: &str, encoding: &'static Encoding) -> Vec<u8> {
    let (result, _, _) = encoding.encode(data);
    result.into_owned()
}

/// Decode bytes from source encoding to UTF-8 string.
pub fn decode_from(data: &[u8], encoding: &'static Encoding) -> String {
    let (result, _, _) = encoding.decode(data);
    result.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lookup_encoding() {
        assert!(lookup_encoding("gbk").is_some());
        assert!(lookup_encoding("GBK").is_some());
        assert!(lookup_encoding("big5").is_some());
        assert!(lookup_encoding("euc-jp").is_some());
        assert!(lookup_encoding("utf-8").is_none());
        assert!(lookup_encoding("").is_none());
    }

    #[test]
    fn test_roundtrip_gbk() {
        let enc = lookup_encoding("gbk").unwrap();
        let chinese = "你好世界";
        let encoded = encode_to(chinese, enc);
        let decoded = decode_from(&encoded, enc);
        assert_eq!(decoded, chinese);
    }
}
