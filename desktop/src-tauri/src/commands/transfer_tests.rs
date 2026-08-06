use super::transfer::ssh_sha256_fingerprint_matches;

#[test]
fn transfer_fingerprint_accepts_russh_and_openssh_sha256_forms_only() {
    let hash = [0x42; 32];
    let raw = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI";

    assert!(ssh_sha256_fingerprint_matches(raw, &hash));
    assert!(ssh_sha256_fingerprint_matches(
        &format!("SHA256:{raw}"),
        &hash
    ));
    assert!(ssh_sha256_fingerprint_matches(
        &format!("SHA256:{raw}="),
        &hash
    ));
    assert!(!ssh_sha256_fingerprint_matches(
        "SHA256:QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkA",
        &hash
    ));
}
