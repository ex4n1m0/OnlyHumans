// Ensure a per-clone local GK secret exists before compilation: fresh
// clones auto-generate one, so every clone derives its own global key and
// can never join a release-channel room. Release builds instead inject the
// channel secret via OH_GK_A/OH_GK_B env vars (never stored in git).
use std::path::PathBuf;

fn main() {
    // The GK embeds compile-time env vars; without these, changing the
    // env would NOT rebuild the crate and a release build could silently
    // reuse a previous (e.g. local/dev) global key.
    println!("cargo:rerun-if-env-changed=OH_GK_A");
    println!("cargo:rerun-if-env-changed=OH_GK_B");
    println!("cargo:rerun-if-env-changed=OH_GLOBAL_KEY");

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // workspace root = core/.. ; secrets/ lives there
    let secrets = manifest.parent().unwrap().join("secrets");
    std::fs::create_dir_all(&secrets).expect("create secrets dir");
    let local = secrets.join("local-gk.key");
    if !local.exists() {
        use rand::RngCore;
        let mut buf = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut buf);
        std::fs::write(&local, buf).expect("write local-gk.key");
        println!("cargo:warning=generated new per-clone GK secret (this build gets its own room)");
    }
    println!("cargo:rerun-if-changed={}", local.display());
}
