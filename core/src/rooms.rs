//! Room protocol: ONE global community room per global key.
//!
//! - The room id is deterministic: SHA256("OH1-room-v1" | gk). Dev and
//!   production global keys therefore address separate rooms.
//! - The first member HOSTS: it mints a random room key and registers a
//!   signed, TTL'd host record on the hub (`/api/room`). Membership is
//!   granted to anyone proving knowledge of the GK — that is the entire
//!   admission ceremony.
//! - The host delivers the room key (GK-sealed per guest) plus the member
//!   list, broadcasts membership updates on join/leave, and is the only
//!   role that can rotate the key.
//! - Delivery is a mesh: every member seals one frame and the transport
//!   sends it to each member directly. The host going offline pauses new
//!   joins (until a key-holding member takes the record over) but not
//!   chat between connected members.

use crate::crypto::{self, Key, RoomCrypto, RoomId, Sealed};
use libp2p::PeerId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Envelope {
    /// Guest -> host: admission request with GK proof for the global room.
    Join {
        room_id_hex: String,
        guest_id: String,
        guest_nonce_b64: String,
        guest_proof_b64: String,
    },
    /// Host -> guest: the room key GK-sealed for the recipient, plus the
    /// current member list (peer ids, including the recipient).
    KeyDelivery {
        room_id_hex: String,
        epoch: u64,
        key_ct_b64: String,
        members: Vec<String>,
    },
    /// Host -> members: the current member list, sealed under the room key
    /// (only members may learn membership).
    Members { frame: Sealed },
    /// Any member: a sealed chat frame (sent to every member).
    Chat { frame: Sealed },
    /// Host -> members: rotation payload sealed under the current key.
    Rotate { frame: Sealed },
    /// Any member: request that everyone wipes their local message history
    /// for this room. Sealed like a chat frame (kind `clear`) so only room
    /// members can issue it.
    Clear { frame: Sealed },
    /// Member -> members: leaving the room.
    Leave { room_id_hex: String },
    Ack,
    Error { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Host,
    Guest,
}

pub struct RoomState {
    pub crypto: RoomCrypto,
    pub role: Role,
    /// Who currently hosts the room (ourselves when we host).
    pub host: PeerId,
    /// Known member peer ids (including ourselves). Maintained by the
    /// host authoritatively; guests apply host-sent lists.
    pub members: HashSet<String>,
    /// Outgoing sequence numbers are wall-clock seeded so they survive
    /// restarts without persistence (receiver replay guard).
    pub my_seq: u64,
    /// Highest sequence seen per sender (anti-replay).
    seen_seq: HashMap<String, u64>,
    /// A real room key has been installed (vs. the pre-join placeholder).
    has_key: bool,
}

impl RoomState {
    fn new(crypto: RoomCrypto, role: Role, host: PeerId, my_id: &str, has_key: bool) -> Self {
        let mut members = HashSet::new();
        members.insert(my_id.to_string());
        Self {
            crypto,
            role,
            host,
            members,
            my_seq: now_seed(),
            seen_seq: HashMap::new(),
            has_key,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MemberInfo {
    pub peer: String,
    pub host: bool,
}

pub struct Rooms {
    gk: Key,
    my_id: String,
    room_hex: String,
    room: Option<RoomState>,
}

#[derive(Debug, Clone)]
pub enum RoomEvent {
    /// Outgoing envelope for the transport to deliver to `peer`.
    Send { peer: PeerId, envelope: Envelope },
    /// The room became usable (key installed / minted).
    RoomReady { room_id_hex: String, host: PeerId, role: Role, epoch: u64 },
    /// Plaintext chat message received.
    Message { room_id_hex: String, sender: String, body: Vec<u8>, epoch: u64 },
    /// The member list changed.
    MembersChanged { room_id_hex: String, members: Vec<String> },
    /// Every participant should wipe its local message history.
    MessagesCleared { room_id_hex: String },
    /// A key rotation was applied.
    Rotated { room_id_hex: String, new_epoch: u64 },
    ProtocolError { context: String },
}

/// Deterministic room id for a global key: hex(SHA256("OH1-room-v1" | gk)
/// truncated to the 16-byte RoomId).
pub fn global_room_hex(gk: &Key) -> String {
    let mut h = Sha256::new();
    h.update(b"OH1-room-v1|");
    h.update(gk);
    hex::encode(&h.finalize()[..16])
}

#[derive(Serialize, Deserialize)]
struct MembersPayload {
    members: Vec<String>,
}

impl Rooms {
    pub fn new(gk: Key, my_id: String) -> Self {
        let room_hex = global_room_hex(&gk);
        Self { gk, my_id, room_hex, room: None }
    }

    pub fn my_id(&self) -> &str {
        &self.my_id
    }

    pub fn room_hex(&self) -> &str {
        &self.room_hex
    }

    pub fn state(&self) -> Option<&RoomState> {
        self.room.as_ref()
    }

    pub fn is_ready(&self) -> bool {
        self.room.as_ref().map(|st| st.has_key).unwrap_or(false)
    }

    pub fn is_host(&self) -> bool {
        self.room.as_ref().map(|st| st.role == Role::Host).unwrap_or(false)
    }

    pub fn members(&self) -> Vec<String> {
        self.room
            .as_ref()
            .map(|st| st.members.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Founding (or takeover): mint a random key for the fixed room id and
    /// host it. Takeover passes the existing key so members keep history.
    pub fn become_host(&mut self, existing_key: Option<Key>, epoch: u64) {
        let room_id: RoomId = match hex::decode(&self.room_hex)
            .ok()
            .and_then(|v| v.try_into().ok())
        {
            Some(r) => r,
            None => return,
        };
        let key = existing_key.unwrap_or_else(|| {
            let mut k = Key::default();
            rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut k);
            k
        });
        let mut crypto = RoomCrypto::from_delivered(room_id, key);
        crypto.epoch = epoch.max(1);
        let host_id = self
            .my_id
            .parse::<PeerId>()
            .expect("my_id is a valid peer id");
        self.room = Some(RoomState::new(crypto, Role::Host, host_id, &self.my_id, true));
    }

    /// Restore a member list (from the contacts store) into a restored
    /// room, so fan-out works immediately after a restart. The host's
    /// authoritative list re-converges as guests re-join.
    pub fn restore_members(&mut self, peers: Vec<String>) {
        if let Some(st) = self.room.as_mut() {
            for p in peers {
                if p.parse::<PeerId>().is_ok() {
                    st.members.insert(p);
                }
            }
        }
    }

    /// Drop in-memory room state (e.g. we minted a key but lost the
    /// host-record race before anyone joined us).
    pub fn reset(&mut self) {
        self.room = None;
    }

    /// Build the Join envelope with a fresh GK proof.
    pub fn join_envelope(&self) -> Envelope {
        let mut gnonce = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut gnonce);
        let gproof = crypto::admission_proof(&self.gk, &self.my_id, &gnonce);
        Envelope::Join {
            room_id_hex: self.room_hex.clone(),
            guest_id: self.my_id.clone(),
            guest_nonce_b64: crypto::base64_encode(&gnonce),
            guest_proof_b64: crypto::base64_encode(&gproof),
        }
    }

    /// Seal a chat message (one frame, transported to every member).
    pub fn seal_chat(&mut self, body: &[u8]) -> Option<Sealed> {
        let st = self.room.as_mut()?;
        if !st.has_key {
            return None; // still joining
        }
        st.my_seq += 1;
        Some(st.crypto.seal(&self.my_id, st.my_seq, crypto::kinds::CHAT, body))
    }

    /// Build the sealed clear-history frame (one per member fan-out).
    pub fn clear_envelope(&mut self) -> Option<Sealed> {
        let st = self.room.as_mut()?;
        if !st.has_key {
            return None;
        }
        st.my_seq += 1;
        Some(st.crypto.seal(&self.my_id, st.my_seq, crypto::kinds::CLEAR, b""))
    }

    /// Host: rotate the room key. Returns the sealed rotation frame (to
    /// send to every member) after committing our own state.
    pub fn rotate(&mut self) -> Option<Sealed> {
        let st = self.room.as_mut()?;
        if st.role != Role::Host || !st.has_key {
            return None;
        }
        let secret = st.crypto.prepare_rotation();
        let payload = serde_json::to_vec(&secret).expect("serialize rotation");
        st.my_seq += 1;
        let frame = st.crypto.seal(&self.my_id, st.my_seq, crypto::kinds::ROTATE, &payload);
        st.crypto.commit_rotation(&secret).ok()?;
        Some(frame)
    }

    /// Restore a persisted room (startup). Guests re-join to resync.
    pub fn restore(&mut self, host: PeerId, role: Role, key: Key, epoch: u64) {
        if self.room.is_some() {
            return;
        }
        let room_id: RoomId = match hex::decode(&self.room_hex)
            .ok()
            .and_then(|v| v.try_into().ok())
        {
            Some(r) => r,
            None => return,
        };
        let mut crypto = RoomCrypto::from_delivered(room_id, key);
        crypto.epoch = epoch.max(1);
        self.room = Some(RoomState::new(crypto, role, host, &self.my_id, true));
    }

    /// Process an incoming envelope from `from`.
    pub fn handle(&mut self, from: PeerId, env: Envelope) -> Vec<RoomEvent> {
        let mut out = Vec::new();
        match env {
            Envelope::Join {
                room_id_hex,
                guest_id,
                guest_nonce_b64,
                guest_proof_b64,
            } => {
                if room_id_hex != self.room_hex {
                    out.push(RoomEvent::Send {
                        peer: from,
                        envelope: Envelope::Error { message: "unknown room".into() },
                    });
                    return out;
                }
                let is_host = self.room.as_ref().map(|st| st.role == Role::Host).unwrap_or(false);
                if !is_host {
                    out.push(RoomEvent::Send {
                        peer: from,
                        envelope: Envelope::Error {
                            message: "not the host (record expired?)".into(),
                        },
                    });
                    return out;
                }
                let nonce: [u8; 16] = match crypto::base64_decode(&guest_nonce_b64)
                    .ok()
                    .and_then(|v| v.try_into().ok())
                {
                    Some(n) => n,
                    None => {
                        out.push(err("malformed join nonce"));
                        return out;
                    }
                };
                let proof: Key = match crypto::base64_decode(&guest_proof_b64)
                    .ok()
                    .and_then(|v| v.try_into().ok())
                {
                    Some(p) => p,
                    None => {
                        out.push(err("malformed join proof"));
                        return out;
                    }
                };
                if guest_id != from.to_string() {
                    out.push(err("join guest id does not match connection"));
                    return out;
                }
                if !crypto::verify_admission_proof(&self.gk, &guest_id, &nonce, &proof) {
                    out.push(err(&format!("join GK proof failed from {from}")));
                    return out;
                }
                out.extend(self.admit(from));
            }
            Envelope::KeyDelivery {
                room_id_hex,
                epoch,
                key_ct_b64,
                members,
            } => {
                if room_id_hex != self.room_hex {
                    out.push(err("key delivery for unknown room"));
                    return out;
                }
                let ct = match crypto::base64_decode(&key_ct_b64) {
                    Ok(c) => c,
                    Err(_) => {
                        out.push(err("malformed key delivery"));
                        return out;
                    }
                };
                let room_id: RoomId = match hex::decode(&room_id_hex)
                    .ok()
                    .and_then(|v| v.try_into().ok())
                {
                    Some(r) => r,
                    None => {
                        out.push(err("bad room id in delivery"));
                        return out;
                    }
                };
                // The seal was made for OUR id — we are the joiner here.
                let key = match crypto::open_room_key(&self.gk, &room_id, &self.my_id, &ct) {
                    Ok(k) => k,
                    Err(e) => {
                        out.push(err(&format!("key delivery failed: {e}")));
                        return out;
                    }
                };
                // Re-delivery after a re-join: keep our state (replay
                // guard) but still apply the fresh member list.
                if let Some(st) = self.room.as_mut() {
                    if st.has_key {
                        let list = sanitize_members(members, &self.my_id);
                        st.members = list;
                        out.push(RoomEvent::MembersChanged {
                            room_id_hex: room_id_hex.clone(),
                            members: st.members.iter().cloned().collect(),
                        });
                        return out;
                    }
                }
                self.room = Some(RoomState::new(
                    RoomCrypto::from_delivered(room_id, key),
                    Role::Guest,
                    from,
                    &self.my_id,
                    true,
                ));
                if let Some(st) = self.room.as_mut() {
                    st.crypto.epoch = epoch.max(1);
                    st.members = sanitize_members(members, &self.my_id);
                }
                out.push(RoomEvent::RoomReady {
                    room_id_hex: room_id_hex.clone(),
                    host: from,
                    role: Role::Guest,
                    epoch,
                });
                out.push(RoomEvent::MembersChanged {
                    room_id_hex,
                    members: self.members(),
                });
            }
            Envelope::Members { frame } => {
                let room_hex = frame.room_id_hex.clone();
                match self.open_frame(&frame, crypto::kinds::MEMBERS) {
                    Ok((body, _, _)) => {
                        match serde_json::from_slice::<MembersPayload>(&body) {
                            Ok(p) => {
                                if let Some(st) = self.room.as_mut() {
                                    st.members = sanitize_members(p.members, &self.my_id);
                                    out.push(RoomEvent::MembersChanged {
                                        room_id_hex: room_hex,
                                        members: st.members.iter().cloned().collect(),
                                    });
                                }
                            }
                            Err(e) => out.push(err(&format!("bad members payload: {e}"))),
                        }
                    }
                    Err(e) => out.push(err(&format!("members: {e}"))),
                }
            }
            Envelope::Chat { frame } => match self.open_frame(&frame, crypto::kinds::CHAT) {
                Ok((body, epoch, sender)) => out.push(RoomEvent::Message {
                    room_id_hex: frame.room_id_hex,
                    sender,
                    body,
                    epoch,
                }),
                Err(e) => out.push(err(&format!("chat: {e}"))),
            },
            Envelope::Rotate { frame } => {
                let room_hex = frame.room_id_hex.clone();
                match self.open_frame(&frame, crypto::kinds::ROTATE) {
                    Ok((body, _, sender)) => {
                        // Only the host may rotate.
                        if let Some(st) = self.room.as_ref() {
                            if sender != st.host.to_string() {
                                out.push(err("rotation from non-host rejected"));
                                return out;
                            }
                        }
                        match serde_json::from_slice::<crypto::RotationSecret>(&body) {
                            Ok(secret) => {
                                if let Some(st) = self.room.as_mut() {
                                    let new_epoch = secret.next_epoch;
                                    if st.crypto.apply_rotation(&secret).is_ok() {
                                        out.push(RoomEvent::Rotated { room_id_hex: room_hex, new_epoch });
                                    } else {
                                        out.push(err("rotation rejected (epoch mismatch?)"));
                                    }
                                }
                            }
                            Err(e) => out.push(err(&format!("bad rotation payload: {e}"))),
                        }
                    }
                    Err(e) => out.push(err(&format!("rotate: {e}"))),
                }
            }
            Envelope::Clear { frame } => {
                let room_hex = frame.room_id_hex.clone();
                match self.open_frame(&frame, crypto::kinds::CLEAR) {
                    Ok(_) => out.push(RoomEvent::MessagesCleared { room_id_hex: room_hex }),
                    Err(e) => out.push(err(&format!("clear: {e}"))),
                }
            }
            Envelope::Leave { room_id_hex } => {
                if room_id_hex == self.room_hex {
                    if let Some(st) = self.room.as_mut() {
                        st.members.remove(&from.to_string());
                    }
                    if self.is_host() {
                        out.extend(self.broadcast_members());
                    }
                    out.push(RoomEvent::MembersChanged {
                        room_id_hex,
                        members: self.members(),
                    });
                }
            }
            Envelope::Ack | Envelope::Error { .. } => {}
        }
        out
    }

    /// Host: admit `guest` — record membership, deliver the key + member
    /// list, and tell existing members about the newcomer.
    fn admit(&mut self, guest: PeerId) -> Vec<RoomEvent> {
        let Some(st) = self.room.as_ref() else {
            return vec![err("admit: no room")];
        };
        if st.role != Role::Host {
            return vec![err("admit: not host")];
        }
        let key = *st.crypto.room_key();
        let room_id: RoomId = st.crypto.room_id;
        let epoch = st.crypto.epoch;
        let members: Vec<String> = {
            let st = self.room.as_mut().unwrap();
            st.members.insert(guest.to_string());
            st.members.iter().cloned().collect()
        };
        let ct = crypto::seal_room_key(&self.gk, &room_id, &guest.to_string(), &key);
        let mut out = vec![
            RoomEvent::Send {
                peer: guest,
                envelope: Envelope::KeyDelivery {
                    room_id_hex: self.room_hex.clone(),
                    epoch,
                    key_ct_b64: crypto::base64_encode(&ct),
                    members: members.clone(),
                },
            },
            RoomEvent::MembersChanged {
                room_id_hex: self.room_hex.clone(),
                members: members.clone(),
            },
        ];
        out.extend(self.broadcast_members());
        out
    }

    /// Host: seal the current member list for every member (the freshly
    /// admitted guest gets the list in KeyDelivery already, but a single
    /// uniform broadcast keeps everyone in sync).
    fn broadcast_members(&mut self) -> Vec<RoomEvent> {
        let Some(st) = self.room.as_ref() else { return vec![] };
        if st.role != Role::Host || !st.has_key {
            return vec![];
        }
        let payload = MembersPayload { members: st.members.iter().cloned().collect() };
        let body = serde_json::to_vec(&payload).expect("serialize members");
        // borrow gymnastics: seal needs &self.crypto, events need member ids
        let frame = {
            let st = self.room.as_mut().unwrap();
            st.my_seq += 1;
            st.crypto.seal(&self.my_id, st.my_seq, crypto::kinds::MEMBERS, &body)
        };
        let peers: Vec<PeerId> = self
            .room
            .as_ref()
            .unwrap()
            .members
            .iter()
            .filter_map(|m| m.parse().ok())
            .collect();
        peers
            .into_iter()
            .map(|peer| RoomEvent::Send { peer, envelope: Envelope::Members { frame: frame.clone() } })
            .collect()
    }

    /// The mesh send set: every member's PeerId.
    pub fn member_peers(&self) -> Vec<PeerId> {
        self.members().iter().filter_map(|m| m.parse().ok()).collect()
    }

    fn open_frame(
        &mut self,
        frame: &Sealed,
        kind: &[u8; 8],
    ) -> anyhow::Result<(Vec<u8>, u64, String)> {
        if frame.room_id_hex != self.room_hex {
            anyhow::bail!("frame for unknown room");
        }
        let st = self
            .room
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("no room state"))?;
        let sender = frame.sender.clone();
        let seq = frame.seq;
        let epoch = frame.epoch;
        let body = st.crypto.open(frame, kind)?;
        let last = st.seen_seq.get(&sender).copied().unwrap_or(0);
        if seq <= last {
            anyhow::bail!("replayed sequence {seq} from {sender}");
        }
        st.seen_seq.insert(sender.clone(), seq);
        Ok((body, epoch, sender))
    }
}

/// Keep the list sane: dedup, always include ourselves, parseable only.
fn sanitize_members(list: Vec<String>, my_id: &str) -> HashSet<String> {
    let mut set: HashSet<String> = list.into_iter().filter(|m| m.parse::<PeerId>().is_ok()).collect();
    set.insert(my_id.to_string());
    set
}

/// Wall-clock seed for outgoing sequence numbers: strictly increasing
/// across restarts without persistence.
fn now_seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn err(context: &str) -> RoomEvent {
    RoomEvent::ProtocolError { context: context.to_string() }
}
