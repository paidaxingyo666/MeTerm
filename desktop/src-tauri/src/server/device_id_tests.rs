use super::load_or_create_device_id;

/// 首次调用应生成合法 UUID并落盘;二次调用读同一目录应返回相同 ID(持久化)。
#[test]
fn device_id_persists_across_calls() {
    let dir = std::env::temp_dir().join(format!("meterm-device-id-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let state_dir = dir.to_string_lossy().to_string();

    let first = load_or_create_device_id(&state_dir);
    assert!(
        uuid::Uuid::parse_str(&first).is_ok(),
        "device id must be a valid UUID: {}",
        first
    );

    let second = load_or_create_device_id(&state_dir);
    assert_eq!(
        first, second,
        "device id must persist across calls on the same state_dir"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
