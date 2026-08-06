use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;

const REGISTER_SECRET: &[u8] = b"test-register-secret-at-least-32-bytes";
const DESKTOP: &str = "desktop-123";
const PHONE: &str = "phone-456";
const RELAY_RENEWAL_MARKER: u8 = super::super::relay_renewal_preface::STREAM_MARKER;
const TLS_HANDSHAKE_RECORD: u8 = super::super::relay_renewal_preface::TLS_HANDSHAKE_RECORD;
const GOLDEN_PREFACE: &str = "8U1UUlIBCwlkZXNrdG9wLTEyM3Bob25lLTQ1NgABAgMEBQYHCAkKCwwNDg8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFdHpH2YMpeXxq0gQ9JwDiNC_Os8tSvFQ3tULplSCgmboKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr-LZEMswCRsB1uWid_bqRiJK_RUUDEuCzmIsXj1JlPQIQ";

#[tokio::test]
async fn relay_stream_classifier_preserves_normal_tls_record_byte() {
    let (mut writer, reader) = tokio::io::duplex(16);
    writer
        .write_all(&[TLS_HANDSHAKE_RECORD, 0x03])
        .await
        .unwrap();

    let (kind, mut classified) = classify_relay_stream(reader, REGISTER_SECRET, DESKTOP)
        .await
        .unwrap();
    assert_eq!(kind, RelayStreamKind::Full);
    let mut bytes = [0u8; 2];
    classified.read_exact(&mut bytes).await.unwrap();
    assert_eq!(bytes, [TLS_HANDSHAKE_RECORD, 0x03]);
}

#[tokio::test]
async fn ordinary_connect_cannot_self_select_renewal_with_bare_marker() {
    let (mut writer, reader) = tokio::io::duplex(16);
    writer
        .write_all(&[RELAY_RENEWAL_MARKER, TLS_HANDSHAKE_RECORD])
        .await
        .unwrap();
    drop(writer);

    assert!(classify_relay_stream(reader, REGISTER_SECRET, DESKTOP)
        .await
        .is_none());
}

#[tokio::test]
async fn authenticated_golden_preface_selects_renewal_and_preserves_tls_byte() {
    let mut bytes = URL_SAFE_NO_PAD.decode(GOLDEN_PREFACE).unwrap();
    bytes.extend_from_slice(&[TLS_HANDSHAKE_RECORD, 0x03]);
    let (mut writer, reader) = tokio::io::duplex(512);
    writer.write_all(&bytes).await.unwrap();

    let (kind, mut classified) = classify_relay_stream(reader, REGISTER_SECRET, DESKTOP)
        .await
        .unwrap();
    let RelayStreamKind::Renewal(context) = kind else {
        panic!("golden preface must select renewal");
    };
    assert_eq!(context.desktop_device_id(), DESKTOP);
    assert_eq!(context.client_id(), PHONE);
    assert_eq!(context.pair_epoch(), "AAECAwQFBgcICQoLDA0ODw");
    assert_eq!(
        context.key_thumbprint(),
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );
    assert_eq!(format!("{context:?}"), "RelayRenewalContext(redacted)");
    let mut tls = [0u8; 2];
    classified.read_exact(&mut tls).await.unwrap();
    assert_eq!(tls, [TLS_HANDSHAKE_RECORD, 0x03]);
}

#[tokio::test]
async fn renewal_preface_rejects_tampering_wrong_secret_and_cross_desktop() {
    for mutation in ["tag", "secret", "desktop"] {
        let mut bytes = URL_SAFE_NO_PAD.decode(GOLDEN_PREFACE).unwrap();
        let secret: &[u8] = if mutation == "secret" {
            b"different-register-secret-at-least-32-bytes"
        } else {
            REGISTER_SECRET
        };
        let desktop = if mutation == "desktop" {
            "desktop-other"
        } else {
            DESKTOP
        };
        if mutation == "tag" {
            *bytes.last_mut().unwrap() ^= 1;
        }
        bytes.push(TLS_HANDSHAKE_RECORD);
        let (mut writer, reader) = tokio::io::duplex(512);
        writer.write_all(&bytes).await.unwrap();
        drop(writer);
        assert!(
            classify_relay_stream(reader, secret, desktop)
                .await
                .is_none(),
            "{mutation} must fail closed"
        );
    }
}

#[tokio::test]
async fn renewal_preface_must_be_followed_immediately_by_tls() {
    let mut bytes = URL_SAFE_NO_PAD.decode(GOLDEN_PREFACE).unwrap();
    bytes.push(0x47);
    let (mut writer, reader) = tokio::io::duplex(512);
    writer.write_all(&bytes).await.unwrap();
    drop(writer);

    assert!(classify_relay_stream(reader, REGISTER_SECRET, DESKTOP)
        .await
        .is_none());
}

#[tokio::test]
async fn renewal_preface_rejects_oversize_identifier_lengths_before_allocation() {
    let bytes = [RELAY_RENEWAL_MARKER, b'M', b'T', b'R', b'R', 1, 129, 1];
    let (mut writer, reader) = tokio::io::duplex(16);
    writer.write_all(&bytes).await.unwrap();
    drop(writer);

    assert!(classify_relay_stream(reader, REGISTER_SECRET, DESKTOP)
        .await
        .is_none());
}

#[tokio::test]
async fn relay_stream_classifier_drops_unknown_protocol() {
    let (mut writer, reader) = tokio::io::duplex(16);
    writer.write_all(&[0x47]).await.unwrap();
    assert!(classify_relay_stream(reader, REGISTER_SECRET, DESKTOP)
        .await
        .is_none());
}
