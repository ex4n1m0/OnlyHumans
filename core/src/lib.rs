// OnlyHumans core — peer-to-peer chat with a Vercel address hub.
// Proprietary/unlicensed (user's choice); no third-party copyleft code.

pub mod crypto;
pub mod hub;
pub mod identity;
pub mod net;
pub mod rooms;
pub mod store;

/// The community global key. Embedded at build time from a gitignored file
/// (secrets/global.key) or the OH_GLOBAL_KEY env override (hex).
///
/// Dev fallback: a 1-byte file (content `0`) hashes to a stable dev key so
/// fresh clones can run tests without holding the real community key.
pub fn global_key() -> crypto::Key {
    use sha2::{Digest, Sha256};
    const EMBEDDED: &[u8] = include_bytes!("../../secrets/global.key");

    let raw: Vec<u8> = match option_env!("OH_GLOBAL_KEY") {
        Some(hexstr) => hex::decode(hexstr).expect("OH_GLOBAL_KEY must be hex"),
        None => {
            let v = EMBEDDED.to_vec();
            if v.len() != 32 && v.len() != 1 {
                panic!("secrets/global.key must be 32 bytes (or a single 0 byte for dev)");
            }
            v
        }
    };
    let mut k = crypto::Key::default();
    k.copy_from_slice(&Sha256::digest(&raw));
    k
}
