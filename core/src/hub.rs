//! Address-hub client. The hub (Vercel + Upstash) is a dumb, signed
//! {peer_id -> addresses} directory with TTL; clients verify every record
//! they fetch and trust nothing beyond reachability hints.

use crate::identity::Identity;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registration {
    pub peer_id: String,
    pub public_key_b64: String,
    pub addrs: Vec<String>,
    pub ts_ms: u64,
    pub sig_b64: String,
}

/// Who currently hosts a room: a signed, TTL-scoped pointer so joiners can
/// find the host through the hub. First writer wins (the endpoint stores
/// with NX), which is the room-creation election.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomHostRecord {
    pub room_id: String,
    pub host_peer_id: String,
    pub host_public_key_b64: String,
    pub ts_ms: u64,
    pub sig_b64: String,
}

fn room_canonical(room_id: &str, host: &str, pub_b64: &str, ts_ms: u64) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"OH1-room|");
    v.extend_from_slice(room_id.as_bytes());
    v.push(b'|');
    v.extend_from_slice(host.as_bytes());
    v.push(b'|');
    v.extend_from_slice(pub_b64.as_bytes());
    v.push(b'|');
    v.extend_from_slice(ts_ms.to_string().as_bytes());
    v
}

/// Canonical bytes that get signed for registration.
fn canonical(peer_id: &str, pub_b64: &str, addrs: &[String], ts_ms: u64) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"OH1-reg|");
    v.extend_from_slice(peer_id.as_bytes());
    v.push(b'|');
    v.extend_from_slice(pub_b64.as_bytes());
    v.push(b'|');
    v.extend_from_slice(addrs.join(",").as_bytes());
    v.push(b'|');
    v.extend_from_slice(ts_ms.to_string().as_bytes());
    v
}

pub struct HubClient {
    base: String,
    http: reqwest::Client,
}

pub const DEFAULT_HUB: &str = "https://onlyhumans.deepflux.space";

impl HubClient {
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("reqwest client"),
        }
    }

    pub async fn register(&self, id: &Identity, addrs: Vec<String>) -> anyhow::Result<()> {
        let ts_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
        let pub_b64 = crate::crypto::base64_encode(&id.public_key_bytes());
        let canon = canonical(&id.id_string(), &pub_b64, &addrs, ts_ms);
        let sig = id.sign(&canon)?;
        let reg = Registration {
            peer_id: id.id_string(),
            public_key_b64: pub_b64,
            addrs,
            ts_ms,
            sig_b64: crate::crypto::base64_encode(&sig),
        };
        let resp = self
            .http
            .put(format!("{}/api/reg", self.base))
            .json(&reg)
            .send()
            .await?;
        if !resp.status().is_success() {
            anyhow::bail!("hub register failed: {} {}", resp.status(), resp.text().await.unwrap_or_default());
        }
        Ok(())
    }

    /// Look up a peer; returns None if unknown/expired. Signatures are
    /// verified locally before returning (the hub is untrusted storage).
    pub async fn lookup(&self, peer_id: &str) -> anyhow::Result<Option<Registration>> {
        let resp = self
            .http
            .get(format!("{}/api/lookup/{peer_id}", self.base))
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            anyhow::bail!("hub lookup failed: {}", resp.status());
        }
        let reg: Registration = resp.json().await?;
        let pub_bytes = crate::crypto::base64_decode(&reg.public_key_b64)?;
        let sig = crate::crypto::base64_decode(&reg.sig_b64)?;
        let canon = canonical(&reg.peer_id, &reg.public_key_b64, &reg.addrs, reg.ts_ms);
        if reg.peer_id != peer_id {
            anyhow::bail!("hub returned a different peer id than requested");
        }
        if !Identity::verify(&pub_bytes, &canon, &sig) {
            anyhow::bail!("hub record failed signature verification");
        }
        Ok(Some(reg))
    }

    /// Publish ourselves as the host of `room_id`. Returns false when the
    /// record already exists (someone else hosts — first-writer-wins
    /// election lost, so join them instead).
    pub async fn register_room(&self, id: &Identity, room_id: &str) -> anyhow::Result<bool> {
        let ts_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
        let pub_b64 = crate::crypto::base64_encode(&id.public_key_bytes());
        let canon = room_canonical(room_id, &id.id_string(), &pub_b64, ts_ms);
        let sig = id.sign(&canon)?;
        let rec = RoomHostRecord {
            room_id: room_id.to_string(),
            host_peer_id: id.id_string(),
            host_public_key_b64: pub_b64,
            ts_ms,
            sig_b64: crate::crypto::base64_encode(&sig),
        };
        let resp = self
            .http
            .put(format!("{}/api/room", self.base))
            .json(&rec)
            .send()
            .await?;
        match resp.status() {
            s if s.is_success() => Ok(true),
            reqwest::StatusCode::CONFLICT => Ok(false),
            s => anyhow::bail!("room register failed: {} {}", s, resp.text().await.unwrap_or_default()),
        }
    }

    /// Fetch (and verify) the current host record of a room.
    pub async fn lookup_room(&self, room_id: &str) -> anyhow::Result<Option<RoomHostRecord>> {
        let resp = self
            .http
            .get(format!("{}/api/room/{room_id}", self.base))
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            anyhow::bail!("room lookup failed: {}", resp.status());
        }
        let rec: RoomHostRecord = resp.json().await?;
        let pub_bytes = crate::crypto::base64_decode(&rec.host_public_key_b64)?;
        let sig = crate::crypto::base64_decode(&rec.sig_b64)?;
        let canon = room_canonical(&rec.room_id, &rec.host_peer_id, &rec.host_public_key_b64, rec.ts_ms);
        if rec.room_id != room_id {
            anyhow::bail!("hub returned a different room id than requested");
        }
        if !Identity::verify(&pub_bytes, &canon, &sig) {
            anyhow::bail!("room record failed signature verification");
        }
        Ok(Some(rec))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_signing_is_verifiable() {
        // Exercise canonical()+verify without a network.
        let dir = std::env::temp_dir().join(format!("oh-hub-{}", std::process::id()));
        let id = Identity::load_or_create(&dir).unwrap();
        let pub_b64 = crate::crypto::base64_encode(&id.public_key_bytes());
        let addrs = vec!["/ip4/1.2.3.4/udp/4001/quic-v1".to_string()];
        let ts = 1234567890u64;
        let canon = canonical(&id.id_string(), &pub_b64, &addrs, ts);
        let sig = id.sign(&canon).unwrap();
        assert!(Identity::verify(
            &id.public_key_bytes(),
            &canon,
            &sig
        ));
        // Tampered addrs must fail
        let canon2 = canonical(&id.id_string(), &pub_b64, &["/ip4/9.9.9.9".to_string()], ts);
        assert!(!Identity::verify(&id.public_key_bytes(), &canon2, &sig));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
