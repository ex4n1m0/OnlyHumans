// OnlyHumans core — peer-to-peer chat with a Vercel address hub.
// Proprietary/unlicensed (user's choice); no third-party copyleft code.

pub mod crypto;
pub mod hub;
pub mod identity;
pub mod net;
pub mod rooms;
pub mod store;

/// Public release-channel identifier (16 bytes, committed). Same for every
/// clone, but by itself it derives nothing useful — the room key domain
/// also needs the channel secret, which exists only in release builds.
static GK_CHANNEL: &[u8] = include_bytes!("gk_channel.bin");

/// The community global key.
///
/// GK = SHA-256("OH1-gk-v2|" | channel | secret) where the secret comes
/// from exactly one of:
///  * release builds: `OH_GK_A` / `OH_GK_B` compile-time env vars — two
///    XOR shares of the channel secret, so no contiguous key blob exists
///    in the source tree or the binary;
///  * everyone else (fresh clones, CI, dev): a per-clone random secret in
///    the gitignored `secrets/local-gk.key`, auto-generated on first
///    build — every clone gets its own global key and therefore its own
///    room, and can never join a release-channel room.
///
/// `OH_GLOBAL_KEY` (raw hex) remains as a build-time override.
pub fn global_key() -> crypto::Key {
    const DOMAIN: &[u8] = b"OH1-gk-v2|";

    let secret: [u8; 32] = if let Some(hexstr) = option_env!("OH_GLOBAL_KEY") {
        let mut k = crypto::Key::default();
        let raw = hex::decode(hexstr).expect("OH_GLOBAL_KEY must be hex");
        assert!(raw.len() == 32, "OH_GLOBAL_KEY must be 32 bytes");
        k.copy_from_slice(&raw);
        k
    } else if let (Some(a), Some(b)) = (option_env!("OH_GK_A"), option_env!("OH_GK_B")) {
        let a = hex::decode(a).expect("OH_GK_A must be hex");
        let b = hex::decode(b).expect("OH_GK_B must be hex");
        let s = derive_gk_secret(&a, &b);
        let mut k = crypto::Key::default();
        k.copy_from_slice(&s);
        k
    } else {
        // Per-clone local secret; build.rs guarantees the file exists.
        let raw: Vec<u8> = include_bytes!("../../secrets/local-gk.key").to_vec();
        let mut k = crypto::Key::default();
        assert!(raw.len() == 32, "local-gk.key must be 32 bytes");
        k.copy_from_slice(&raw);
        k
    };

    derive_gk(GK_CHANNEL, &secret)
}

/// Recombine the two release shares into the channel secret. The shares
/// are scattered constants in the binary; the secret itself exists only
/// in registers/heap at runtime.
fn derive_gk_secret(a: &[u8], b: &[u8]) -> [u8; 32] {
    assert!(a.len() == 32 && b.len() == 32, "GK shares must be 32 bytes");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = a[i] ^ b[i];
    }
    out
}

fn derive_gk(channel: &[u8], secret: &[u8; 32]) -> crypto::Key {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"OH1-gk-v2|");
    h.update(channel);
    h.update(secret);
    let mut k = crypto::Key::default();
    k.copy_from_slice(&h.finalize());
    k
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn different_secrets_never_share_a_room() {
        let mut s1 = [0u8; 32];
        s1[0] = 1;
        let mut s2 = [0u8; 32];
        s2[0] = 2;
        // Same channel, different secrets -> different GK -> different room.
        assert_ne!(derive_gk(GK_CHANNEL, &s1), derive_gk(GK_CHANNEL, &s2));
        // Different channels with the same secret also isolate rooms.
        assert_ne!(derive_gk(b"other-channel-xx", &s1), derive_gk(GK_CHANNEL, &s1));
        // Determinism: same inputs, same key.
        assert_eq!(derive_gk(GK_CHANNEL, &s1), derive_gk(GK_CHANNEL, &s1));
    }

    #[test]
    fn shares_recombine_to_the_secret() {
        let secret = [42u8; 32];
        let mut a = [7u8; 32];
        for i in 0..32 {
            a[i] = i as u8;
        }
        let b: Vec<u8> = secret.iter().zip(a.iter()).map(|(s, x)| s ^ x).collect();
        assert_eq!(derive_gk_secret(&a, &b), secret);
    }
}
