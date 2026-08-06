//! Algorithm preferences offered during SSH negotiation.
//!
//! Kept out of `ssh.rs` so the compatible-server set is defined, and tested,
//! in one place.

use std::borrow::Cow;

use russh::keys::Algorithm;

/// Build the algorithm preference lists sent in our KEXINIT.
///
/// We deliberately do **not** hand `Preferred::DEFAULT` straight to russh.
/// The upstream default table shifts between releases, and every shift
/// silently changes which servers we can still reach. Concretely: russh 0.46
/// did not offer the `ssh-rsa` host key algorithm, so connecting to a
/// JumpServer Koko bastion — whose RSA host key is announced under exactly
/// that one name — failed during key exchange with an error that carried no
/// algorithm class at all, leaving nothing to diagnose. Upstream added it back
/// in 0.61.
///
/// This builds on the upstream table and only ever **appends**, so newer
/// upstream additions (mlkem768 and friends) keep flowing through, while the
/// entries we depend on are pinned by the tests below. A russh upgrade that
/// narrows the compatible server set then fails CI instead of failing a user
/// in front of a bastion host.
///
/// SHA-1 HMACs are appended too, but strictly last. Upstream dropped them from
/// the defaults in 0.61, which left servers that only speak `hmac-sha1`
/// unreachable — a regression against 0.46 for older bastions and network
/// gear. Ranking them below every SHA-2 entry keeps modern peers unaffected:
/// they either offer a SHA-2 MAC or negotiate an AEAD cipher, in which case
/// MAC negotiation does not happen at all. Note this is a weaker statement
/// than accepting `ssh-rsa` above — the SHA-1 collision attacks that motivated
/// deprecating SHA-1 *signatures* do not translate into a practical break of
/// HMAC-SHA1 — and OpenSSH itself still ships `hmac-sha1` in its defaults.
pub(super) fn preferred_algorithms() -> russh::Preferred {
    let base = russh::Preferred::DEFAULT;

    // Standard on OpenSSH and Go's x/crypto, absent from russh's defaults.
    // Appended last, so they are only selected when the peer offers nothing
    // more modern (curve25519 / mlkem stay ahead of them).
    let mut kex = base.kex.to_vec();
    for name in [
        russh::kex::ECDH_SHA2_NISTP256,
        russh::kex::ECDH_SHA2_NISTP384,
        russh::kex::ECDH_SHA2_NISTP521,
    ] {
        if !kex.contains(&name) {
            kex.push(name);
        }
    }

    // `ssh-rsa` is RSA with a SHA-1 signature. It only signs the host key
    // identity and never feeds session key derivation, and MeTerm pins the
    // host key by SHA-256 fingerprint independently (see
    // `SshHandler::check_server_key`), so forging a SHA-1 signature still does
    // not get past fingerprint verification.
    let mut key = base.key.to_vec();
    let ssh_rsa = Algorithm::Rsa { hash: None };
    if !key.contains(&ssh_rsa) {
        key.push(ssh_rsa);
    }

    let mut cipher = base.cipher.to_vec();
    if !cipher.contains(&russh::cipher::AES_128_GCM) {
        cipher.push(russh::cipher::AES_128_GCM);
    }

    // Last resort only — every SHA-2 entry from upstream stays ahead of these.
    let mut mac = base.mac.to_vec();
    for name in [russh::mac::HMAC_SHA1_ETM, russh::mac::HMAC_SHA1] {
        if !mac.contains(&name) {
            mac.push(name);
        }
    }

    russh::Preferred {
        kex: Cow::Owned(kex),
        key: Cow::Owned(key),
        cipher: Cow::Owned(cipher),
        mac: Cow::Owned(mac),
        compression: base.compression.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression this whole module exists for: a JumpServer Koko bastion
    /// announces its RSA host key as `ssh-rsa` and nothing else, so dropping
    /// that name makes every such bastion unreachable.
    #[test]
    fn offers_ssh_rsa_host_key_for_jumpserver_bastions() {
        let preferred = preferred_algorithms();
        assert!(
            preferred.key.contains(&Algorithm::Rsa { hash: None }),
            "ssh-rsa must stay in the host key offer; without it JumpServer \
             Koko bastions fail key exchange. Offered: {:?}",
            preferred.key
        );
    }

    /// A bastion locked down to NIST curves must stay reachable; russh has
    /// these implemented but leaves them out of its default preference list.
    #[test]
    fn offers_ecdh_nistp_key_exchange() {
        let preferred = preferred_algorithms();
        for expected in [
            russh::kex::ECDH_SHA2_NISTP256,
            russh::kex::ECDH_SHA2_NISTP384,
            russh::kex::ECDH_SHA2_NISTP521,
        ] {
            assert!(
                preferred.kex.contains(&expected),
                "{expected:?} must be offered. Offered: {:?}",
                preferred.kex
            );
        }
    }

    #[test]
    fn offers_aes128_gcm_cipher() {
        let preferred = preferred_algorithms();
        assert!(
            preferred.cipher.contains(&russh::cipher::AES_128_GCM),
            "Offered: {:?}",
            preferred.cipher
        );
    }

    /// Appending compatibility entries must never cost us the modern ones —
    /// a peer offering curve25519 has to keep negotiating curve25519.
    #[test]
    fn keeps_upstream_modern_algorithms_ahead_of_compatibility_ones() {
        let preferred = preferred_algorithms();
        let base = russh::Preferred::DEFAULT;

        for name in base.kex.iter() {
            assert!(
                preferred.kex.contains(name),
                "upstream kex {name:?} was dropped"
            );
        }
        for name in base.key.iter() {
            assert!(
                preferred.key.contains(name),
                "upstream host key {name:?} was dropped"
            );
        }
        for name in base.cipher.iter() {
            assert!(
                preferred.cipher.contains(name),
                "upstream cipher {name:?} was dropped"
            );
        }

        let curve25519 = preferred
            .kex
            .iter()
            .position(|n| *n == russh::kex::CURVE25519)
            .expect("curve25519 must be offered");
        let nistp256 = preferred
            .kex
            .iter()
            .position(|n| *n == russh::kex::ECDH_SHA2_NISTP256)
            .expect("ecdh-nistp256 must be offered");
        assert!(
            curve25519 < nistp256,
            "compatibility key exchange must rank below modern ones"
        );
    }

    /// SHA-1 MACs must be reachable for legacy bastions and network gear, but
    /// must never win against a SHA-2 MAC. Ranking is the whole safety
    /// argument here, so it is asserted rather than assumed.
    #[test]
    fn offers_sha1_macs_but_only_after_every_sha2_one() {
        let preferred = preferred_algorithms();

        for expected in [russh::mac::HMAC_SHA1_ETM, russh::mac::HMAC_SHA1] {
            assert!(
                preferred.mac.contains(&expected),
                "{expected:?} must be offered so servers that only speak SHA-1 \
                 MACs stay reachable. Offered: {:?}",
                preferred.mac
            );
        }

        let sha2 = [
            russh::mac::HMAC_SHA512_ETM,
            russh::mac::HMAC_SHA256_ETM,
            russh::mac::HMAC_SHA512,
            russh::mac::HMAC_SHA256,
        ];
        let last_sha2 = preferred
            .mac
            .iter()
            .rposition(|name| sha2.contains(name))
            .expect("upstream always offers SHA-2 MACs");
        let first_sha1 = preferred
            .mac
            .iter()
            .position(|name| {
                *name == russh::mac::HMAC_SHA1_ETM || *name == russh::mac::HMAC_SHA1
            })
            .expect("asserted present above");

        assert!(
            last_sha2 < first_sha1,
            "SHA-1 MACs must rank below every SHA-2 MAC, otherwise a modern \
             peer could be talked down to SHA-1. Offered: {:?}",
            preferred.mac
        );
    }
}
