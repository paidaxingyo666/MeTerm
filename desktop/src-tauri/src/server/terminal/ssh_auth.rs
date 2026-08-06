//! russh key/authentication compatibility helpers.

use std::fmt::Display;
use std::sync::Arc;

use russh::client::{AuthResult, Handle, Handler};
use russh::keys::agent::AgentIdentity;
use russh::keys::{Algorithm, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use russh::Signer;

/// Preserve the raw SHA-256/base64 form emitted by russh 0.46 so previously
/// confirmed fingerprints remain valid after the dependency upgrade.
pub(super) fn fingerprint(public_key: &PublicKey) -> String {
    let standard = public_key.fingerprint(HashAlg::Sha256).to_string();
    standard
        .strip_prefix("SHA256:")
        .unwrap_or(&standard)
        .trim_end_matches('=')
        .to_string()
}

pub(super) fn key_type(public_key: &PublicKey) -> String {
    public_key.algorithm().to_string()
}

async fn rsa_hash<H: Handler>(
    session: &Handle<H>,
    algorithm: Algorithm,
) -> Result<Option<HashAlg>, russh::Error> {
    if is_rsa(algorithm) {
        Ok(session.best_supported_rsa_hash().await?.flatten())
    } else {
        Ok(None)
    }
}

fn is_rsa(algorithm: Algorithm) -> bool {
    matches!(algorithm, Algorithm::Rsa { .. })
}

pub(super) async fn authenticate_private_key<H: Handler>(
    session: &mut Handle<H>,
    username: &str,
    key: PrivateKey,
) -> Result<AuthResult, russh::Error> {
    let hash = rsa_hash(session, key.algorithm()).await?;
    session
        .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
}

pub(super) async fn authenticate_agent_identity<H, S>(
    session: &mut Handle<H>,
    username: &str,
    identity: AgentIdentity,
    signer: &mut S,
) -> Result<AuthResult, String>
where
    H: Handler,
    S: Signer,
    S::Error: Display,
{
    // Agent identities may be either bare keys or OpenSSH certificates.  In
    // both cases negotiate the signature hash from the underlying public key
    // before handing the signing request to the agent.
    let hash = rsa_hash(session, identity.public_key().algorithm())
        .await
        .map_err(|error| error.to_string())?;

    match identity {
        AgentIdentity::PublicKey { key, .. } => session
            .authenticate_publickey_with(username, key, hash, signer)
            .await
            .map_err(|error| error.to_string()),
        AgentIdentity::Certificate { certificate, .. } => session
            .authenticate_certificate_with(username, certificate, hash, signer)
            .await
            .map_err(|error| error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::MethodSet;

    #[test]
    fn fingerprint_stays_raw_sha256_base64_without_padding() {
        let key = russh::keys::parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ",
        )
        .unwrap();

        assert_eq!(
            fingerprint(&key),
            "T7SvZ2cslqpPj6nKzitCBHHlpVF3r3MvLwmFL0fk0IE"
        );
        assert!(!fingerprint(&key).starts_with("SHA256:"));
        assert!(!fingerprint(&key).ends_with('='));
    }

    #[test]
    fn rsa_detection_covers_negotiated_hash_paths() {
        assert!(is_rsa(Algorithm::Rsa { hash: None }));
        assert!(!is_rsa(Algorithm::Ed25519));
    }

    #[test]
    fn auth_result_failure_is_not_success() {
        let failure = AuthResult::Failure {
            remaining_methods: MethodSet::empty(),
            partial_success: false,
        };
        assert!(!failure.success());
        assert!(AuthResult::Success.success());
    }
}
