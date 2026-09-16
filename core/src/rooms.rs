//! Room protocol: the conversation state machine.
//!
//! Flow (1:1, initiator is the host):
//! 1. Host creates a room (random id + random room key) and dials the
//!    guest with [`Envelope::Invite`], proving knowledge of the GK.
//! 2. Guest verifies the proof and answers [`Envelope::Join`] with its
//!    own GK proof.
//! 3. Host verifies; admission is automatic for contacts, otherwise the
//!    UI must approve. The host then delivers the room key GK-sealed
//!    **for the guest's id** ([`Envelope::KeyDelivery`]).
//! 4. Traffic flows as [`Envelope::Chat`] frames under the room key.
//! 5. Host may [`Envelope::Rotate`]: a new random key sealed under the
//!    CURRENT key — only existing participants learn it.

use crate::crypto::{self, Key, RoomCrypto, RoomId, Sealed};
use libp2p::PeerId;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Envelope {
    /// Host -> guest: room invitation with GK proof.
    Invite {
        room_id_hex: String,
        host_id: String,
        host_nonce_b64: String,
        host_proof_b64: String,
    },
    /// Guest -> host: acceptance with GK proof.
    Join {
        room_id_hex: String,
        guest_id: String,
        guest_nonce_b64: String,
        guest_proof_b64: String,
    },
    /// Host -> guest: the room key, GK-sealed for the recipient (guest id).
    KeyDelivery {
        room_id_hex: String,
        epoch: u64,
        key_ct_b64: String,
    },
    /// Either direction: a sealed chat frame.
    Chat { frame: Sealed },
    /// Host -> participants: rotation payload sealed under current key.
    Rotate { frame: Sealed },
    /// Guest -> host: "do you have rooms for me?" (poll fallback).
    QueryRooms,
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
    pub peer: PeerId,
    /// Outgoing sequence numbers are wall-clock seeded so they survive
    /// restarts without persistence (receiver replay guard).
    pub my_seq: u64,
    /// Highest sequence seen per sender (anti-replay).
    seen_seq: HashMap<String, u64>,
    /// Host: this room was opened (or re-sent) at the guest's own request,
    /// so their Join is admitted without a UI approval.
    pub invited: bool,
    /// Guest: the user already accepted THIS room's invitation. A later
    /// re-Invite (e.g. the host's 90 s QueryRooms resume) is answered with
    /// an automatic re-Join instead of another consent prompt.
    consented: bool,
    /// Guest: a real room key has been installed (vs. the pre-delivery
    /// placeholder). Re-deliveries for a keyed room are ignored so replay
    /// guards (seen_seq) survive resume cycles.
    has_key: bool,
}

/// Outcome of host-side admission handling.
#[derive(Debug)]
pub enum Admission {
    /// Deliver the key now (contact or auto-approve).
    Approved,
    /// Store and surface to the UI.
    NeedsApproval,
}

pub struct Rooms {
    gk: Key,
    my_id: String,
    rooms: HashMap<String, RoomState>,
    /// Joins from non-contacts awaiting UI approval.
    pub pending_approvals: Vec<(PeerId, String)>,
    /// Auto-approve every join (tests / dev mode).
    pub auto_approve: bool,
}

#[derive(Debug, Clone)]
pub enum RoomEvent {
    /// Outgoing envelope for the transport to deliver to `peer`.
    Send { peer: PeerId, envelope: Envelope },
    /// A room became usable.
    RoomReady { room_id_hex: String, peer: PeerId, role: Role, epoch: u64 },
    /// Plaintext chat message received.
    Message { room_id_hex: String, sender: String, body: Vec<u8>, epoch: u64 },
    /// Host-side: someone wants to join and needs UI approval.
    ApprovalRequested { room_id_hex: String, peer: PeerId },
    /// Guest-side: someone invited us; the UI should ask for consent.
    InvitationReceived { room_id_hex: String, host: PeerId },
    /// A key rotation was applied.
    Rotated { room_id_hex: String, new_epoch: u64 },
    ProtocolError { context: String },
}

impl Rooms {
    pub fn new(gk: Key, my_id: String) -> Self {
        Self {
            gk,
            my_id,
            rooms: HashMap::new(),
            pending_approvals: Vec::new(),
            auto_approve: false,
        }
    }

    pub fn my_id(&self) -> &str {
        &self.my_id
    }

    pub fn room(&self, room_id_hex: &str) -> Option<&RoomState> {
        self.rooms.get(room_id_hex)
    }

    pub fn room_mut(&mut self, room_id_hex: &str) -> Option<&mut RoomState> {
        self.rooms.get_mut(room_id_hex)
    }

    /// Host: create a room for `peer` and produce the Invite envelope.
    /// Reuses an existing hosted room for the same peer instead of
    /// minting a new one on every conversation open.
    pub fn host_open_room(&mut self, peer: PeerId) -> (String, RoomEvent) {
        if let Some(hex) = self
            .rooms
            .iter()
            .find(|(_, st)| st.role == Role::Host && st.peer == peer)
            .map(|(hex, _)| hex.clone())
        {
            let ev = self.invite_for(&hex);
            return (hex, ev);
        }
        let rc = RoomCrypto::new_host();
        let room_hex = rc.room_id_hex();
        self.rooms.insert(
            room_hex.clone(),
            RoomState {
                crypto: rc,
                role: Role::Host,
                peer,
                my_seq: now_seed(),
                seen_seq: HashMap::new(),
                invited: true,
                consented: true,
                has_key: true,
            },
        );
        let ev = self.invite_for(&room_hex);
        (room_hex, ev)
    }

    /// Rebuild a room from persisted state (startup restore).
    pub fn restore_room(&mut self, room_hex: &str, peer: PeerId, role: Role, key: Key, epoch: u64) {
        let room_id: RoomId = match hex::decode(room_hex).ok().and_then(|v| v.try_into().ok()) {
            Some(r) => r,
            None => return,
        };
        let mut crypto = RoomCrypto::from_delivered(room_id, key);
        crypto.epoch = epoch.max(1);
        self.rooms.insert(
            room_hex.to_string(),
            RoomState {
                crypto,
                role,
                peer,
                my_seq: now_seed(),
                seen_seq: HashMap::new(),
                invited: true,
                consented: true,
                has_key: true,
            },
        );
    }

    /// Guest: accept a received invitation by sending our Join.
    pub fn accept_invitation(&mut self, room_hex: &str, host: PeerId) -> Option<RoomEvent> {
        if let Some(st) = self.rooms.get_mut(room_hex) {
            st.consented = true;
        } else {
            return None;
        }
        Some(RoomEvent::Send {
            peer: host,
            envelope: self.join_envelope(room_hex),
        })
    }

    /// Build the Join envelope with a fresh GK proof.
    fn join_envelope(&self, room_hex: &str) -> Envelope {
        let mut gnonce = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut gnonce);
        let gproof = crypto::admission_proof(&self.gk, &self.my_id, &gnonce);
        Envelope::Join {
            room_id_hex: room_hex.to_string(),
            guest_id: self.my_id.clone(),
            guest_nonce_b64: crypto::base64_encode(&gnonce),
            guest_proof_b64: crypto::base64_encode(&gproof),
        }
    }

    fn invite_for(&self, room_hex: &str) -> RoomEvent {
        let st = &self.rooms[room_hex];
        let peer = st.peer;
        let mut nonce = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
        let proof = crypto::admission_proof(&self.gk, &self.my_id, &nonce);
        RoomEvent::Send {
            peer,
            envelope: Envelope::Invite {
                room_id_hex: room_hex.to_string(),
                host_id: self.my_id.clone(),
                host_nonce_b64: crypto::base64_encode(&nonce),
                host_proof_b64: crypto::base64_encode(&proof),
            },
        }
    }

    /// Seal a chat message for a room we are in.
    pub fn seal_chat(&mut self, room_hex: &str, body: &[u8]) -> Option<Sealed> {
        let st = self.rooms.get_mut(room_hex)?;
        if !st.has_key {
            return None; // guest still awaiting KeyDelivery
        }
        st.my_seq += 1;
        Some(st.crypto.seal(&self.my_id, st.my_seq, crypto::kinds::CHAT, body))
    }

    /// Host: rotate the room key. Returns the sealed rotation frame
    /// (to broadcast) after committing our own state.
    pub fn rotate(&mut self, room_hex: &str) -> Option<Sealed> {
        let st = self.rooms.get_mut(room_hex)?;
        if st.role != Role::Host {
            return None;
        }
        let secret = st.crypto.prepare_rotation();
        let payload = serde_json::to_vec(&secret).expect("serialize rotation");
        st.my_seq += 1;
        let frame = st.crypto.seal(&self.my_id, st.my_seq, crypto::kinds::ROTATE, &payload);
        st.crypto.commit_rotation(&secret).ok()?;
        Some(frame)
    }

    /// Process an incoming envelope from `from`. `is_contact` drives
    /// automatic admission.
    pub fn handle(&mut self, from: PeerId, env: Envelope, is_contact: bool) -> Vec<RoomEvent> {
        let mut out = Vec::new();
        match env {
            Envelope::Invite {
                room_id_hex,
                host_id,
                host_nonce_b64,
                host_proof_b64,
            } => {
                let nonce: [u8; 16] = match crypto::base64_decode(&host_nonce_b64)
                    .ok()
                    .and_then(|v| v.try_into().ok())
                {
                    Some(n) => n,
                    None => {
                        out.push(err("malformed invite nonce"));
                        return out;
                    }
                };
                let proof: Key = match crypto::base64_decode(&host_proof_b64)
                    .ok()
                    .and_then(|v| v.try_into().ok())
                {
                    Some(p) => p,
                    None => {
                        out.push(err("malformed invite proof"));
                        return out;
                    }
                };
                if !crypto::verify_admission_proof(&self.gk, &host_id, &nonce, &proof) {
                    out.push(RoomEvent::Send {
                        peer: from,
                        envelope: Envelope::Error { message: "GK proof failed".into() },
                    });
                    out.push(err(&format!("invite GK proof failed from {from}")));
                    return out;
                }
                let room_id: RoomId = match hex::decode(&room_id_hex)
                    .ok()
                    .and_then(|v| v.try_into().ok())
                {
                    Some(r) => r,
                    None => {
                        out.push(err("bad room id in invite"));
                        return out;
                    }
                };
                // If we already have a working room with this host, treat a
                // re-invite as a resume and ask the UI again only for new
                // rooms. Placeholder crypto until KeyDelivery arrives.
                let known = self.rooms.get(&room_id_hex);
                match known {
                    None => {
                        self.rooms.insert(
                            room_id_hex.clone(),
                            RoomState {
                                crypto: RoomCrypto::from_delivered(room_id, [0u8; 32]),
                                role: Role::Guest,
                                peer: from,
                                my_seq: now_seed(),
                                seen_seq: HashMap::new(),
                                invited: true,
                                consented: false,
                                has_key: false,
                            },
                        );
                    }
                    Some(st) if st.consented => {
                        // Resume: we already accepted this room; answer with
                        // an automatic re-Join so the host re-delivers only
                        // if we never got the key. No UI prompt.
                        out.push(RoomEvent::Send {
                            peer: from,
                            envelope: self.join_envelope(&room_id_hex),
                        });
                        return out;
                    }
                    Some(_) => {}
                }
                // The INVITED side consents — the inviter already did by
                // inviting. (Re-emitted while still pending.)
                out.push(RoomEvent::InvitationReceived {
                    room_id_hex,
                    host: from,
                });
            }
            Envelope::Join {
                room_id_hex,
                guest_id,
                guest_nonce_b64,
                guest_proof_b64,
            } => {
                let peer_id = match self.rooms.get(&room_id_hex) {
                    Some(st) if st.role == Role::Host => st.peer,
                    _ => {
                        out.push(RoomEvent::Send {
                            peer: from,
                            envelope: Envelope::Error { message: "unknown room".into() },
                        });
                        return out;
                    }
                };
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
                if !crypto::verify_admission_proof(&self.gk, &guest_id, &nonce, &proof) {
                    out.push(err(&format!("join GK proof failed from {from}")));
                    return out;
                }
                let invited = self
                    .rooms
                    .get(&room_id_hex)
                    .map(|st| st.invited)
                    .unwrap_or(false);
                let admission = if invited || is_contact || self.auto_approve {
                    Admission::Approved
                } else {
                    Admission::NeedsApproval
                };
                match admission {
                    Admission::Approved => {
                        out.extend(self.deliver_key_to(&room_id_hex, from));
                        let _ = peer_id;
                    }
                    Admission::NeedsApproval => {
                        self.pending_approvals.push((from, room_id_hex.clone()));
                        out.push(RoomEvent::ApprovalRequested { room_id_hex, peer: from });
                    }
                }
            }
            Envelope::KeyDelivery {
                room_id_hex,
                epoch,
                key_ct_b64,
            } => {
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
                // The seal was made for the GUEST's id — that is us here.
                let key = match crypto::open_room_key(&self.gk, &room_id, &self.my_id, &ct) {
                    Ok(k) => k,
                    Err(e) => {
                        out.push(err(&format!("key delivery failed: {e}")));
                        return out;
                    }
                };
                // Resume cycle: if we already hold the key for this room
                // (e.g. the host re-delivered after its QueryRooms
                // re-invite), keep our state — replacing it would wipe the
                // replay guard.
                if let Some(st) = self.rooms.get(&room_id_hex) {
                    if st.has_key {
                        return out;
                    }
                }
                let st = RoomState {
                    crypto: RoomCrypto::from_delivered(room_id, key),
                    role: Role::Guest,
                    peer: from,
                    my_seq: now_seed(),
                    seen_seq: HashMap::new(),
                    invited: true,
                    consented: true,
                    has_key: true,
                };
                out.push(RoomEvent::RoomReady {
                    room_id_hex: room_id_hex.clone(),
                    peer: from,
                    role: Role::Guest,
                    epoch,
                });
                self.rooms.insert(room_id_hex, st);
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
                    Ok((body, _, _)) => match serde_json::from_slice::<crypto::RotationSecret>(&body) {
                        Ok(secret) => {
                            if let Some(st) = self.rooms.get_mut(&room_hex) {
                                let new_epoch = secret.next_epoch;
                                if st.crypto.apply_rotation(&secret).is_ok() {
                                    out.push(RoomEvent::Rotated { room_id_hex: room_hex, new_epoch });
                                } else {
                                    out.push(err("rotation rejected (epoch mismatch?)"));
                                }
                            }
                        }
                        Err(e) => out.push(err(&format!("bad rotation payload: {e}"))),
                    },
                    Err(e) => out.push(err(&format!("rotate: {e}"))),
                }
            }
            Envelope::QueryRooms => {
                // Re-invite for any room we host whose peer is the asker.
                let hexes: Vec<String> = self
                    .rooms
                    .iter()
                    .filter(|(_, st)| st.role == Role::Host && st.peer == from)
                    .map(|(hex, _)| hex.clone())
                    .collect();
                for hex in hexes {
                    out.push(self.invite_for(&hex));
                }
            }
            Envelope::Leave { room_id_hex } => {
                self.rooms.remove(&room_id_hex);
            }
            Envelope::Ack | Envelope::Error { .. } => {}
        }
        out
    }

    /// Host: GK-seal the room key for `guest` and emit delivery + ready.
    pub fn deliver_key_to(&mut self, room_hex: &str, guest: PeerId) -> Vec<RoomEvent> {
        let Some(st) = self.rooms.get(room_hex) else {
            return vec![err("deliver_key: unknown room")];
        };
        if st.role != Role::Host {
            return vec![err("deliver_key: not host")];
        }
        let key = *st.crypto.room_key();
        let room_id: RoomId = st.crypto.room_id;
        let epoch = st.crypto.epoch;
        // Seal for the GUEST's id — the guest opens with its own id.
        let ct = crypto::seal_room_key(&self.gk, &room_id, &guest.to_string(), &key);
        self.pending_approvals.retain(|(p, _)| *p != guest);
        vec![
            RoomEvent::Send {
                peer: guest,
                envelope: Envelope::KeyDelivery {
                    room_id_hex: room_hex.to_string(),
                    epoch,
                    key_ct_b64: crypto::base64_encode(&ct),
                },
            },
            RoomEvent::RoomReady {
                room_id_hex: room_hex.to_string(),
                peer: guest,
                role: Role::Host,
                epoch,
            },
        ]
    }

    fn open_frame(
        &mut self,
        frame: &Sealed,
        kind: &[u8; 8],
    ) -> anyhow::Result<(Vec<u8>, u64, String)> {
        let st = self
            .rooms
            .get_mut(&frame.room_id_hex)
            .ok_or_else(|| anyhow::anyhow!("frame for unknown room"))?;
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

/// Wall-clock seed for outgoing sequence numbers: strictly increasing
/// across restarts without persistence.
fn now_seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn err(context: &str) -> RoomEvent {
    RoomEvent::ProtocolError {
        context: context.to_string(),
    }
}
