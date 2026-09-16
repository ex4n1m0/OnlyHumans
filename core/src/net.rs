//! The network node: a libp2p swarm speaking the room protocol over
//! request-response, plus address-hub registration and dialing.
//!
//! M1 scope: direct connections (QUIC + TCP, noise-encrypted). Circuit
//! relay v2 + DCUtR hole-punching are staged for the connectivity pass
//! (see README) — the swarm composition keeps a slot for them.

use crate::hub::HubClient;
use crate::identity::Identity;
use crate::rooms::{Envelope, RoomEvent, Rooms};
use crate::store::Store;
use futures::prelude::*;
use libp2p::request_response::{self, Codec as _, ProtocolSupport};
use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
use libp2p::{dcutr, identify, multiaddr::Protocol, ping, relay, Multiaddr, PeerId, Swarm};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;
use tokio::sync::mpsc;

pub const ROOM_PROTOCOL: &str = "/onlyhumans/room/1";

// ---------------------------------------------------------------------------
// Wire codec: 4-byte big-endian length + JSON
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default)]
pub struct EnvelopeCodec;

impl request_response::Codec for EnvelopeCodec {
    type Protocol = String;
    type Request = Envelope;
    type Response = Envelope;

    async fn read_request<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
    ) -> std::io::Result<Self::Request>
    where
        T: futures::AsyncRead + Unpin + Send,
    {
        read_json(io).await
    }

    async fn read_response<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
    ) -> std::io::Result<Self::Response>
    where
        T: futures::AsyncRead + Unpin + Send,
    {
        read_json(io).await
    }

    async fn write_request<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
        req: Self::Request,
    ) -> std::io::Result<()>
    where
        T: futures::AsyncWrite + Unpin + Send,
    {
        write_json(io, &req).await
    }

    async fn write_response<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
        res: Self::Response,
    ) -> std::io::Result<()>
    where
        T: futures::AsyncWrite + Unpin + Send,
    {
        write_json(io, &res).await
    }
}

async fn read_json<T: futures::AsyncRead + Unpin + Send>(io: &mut T) -> std::io::Result<Envelope> {
    let mut len = [0u8; 4];
    io.read_exact(&mut len).await?;
    let n = u32::from_be_bytes(len) as usize;
    if n > 4 * 1024 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; n];
    io.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

async fn write_json<T: futures::AsyncWrite + Unpin + Send>(
    io: &mut T,
    env: &Envelope,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(env)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    io.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
    io.write_all(&bytes).await?;
    io.close().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

#[derive(NetworkBehaviour)]
pub struct Behaviour {
    identify: identify::Behaviour,
    ping: ping::Behaviour,
    relay_client: relay::client::Behaviour,
    /// Relay service for other peers (any reachable node offers it).
    relay: relay::Behaviour,
    /// Hole-punching: upgrades relayed connections to direct when possible.
    dcutr: dcutr::Behaviour,
    rooms: request_response::Behaviour<EnvelopeCodec>,
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum Command {
    /// Open (or resume) a conversation as host with `peer`.
    OpenConversation { peer: String },
    /// Direct dial by multiaddr (used before the hub exists / tests).
    Dial { addr: Multiaddr },
    /// Send a chat message in a room.
    SendMessage { room: String, text: String },
    /// Host-side key rotation.
    Rotate { room: String },
    /// Approve a pending join.
    Approve { peer: String, room: String },
    /// Ask a peer whether it hosts rooms for us.
    Query { peer: String },
    /// Explicitly reserve a relay circuit; `addr` is the relay's full
    /// address ending in /p2p/<relay_id> (tests, port-forwarded hosts).
    ReserveWith { addr: Multiaddr },
    /// Guest: accept a received invitation.
    AcceptInvitation { room: String, host: String },
    /// Stop the node task (releases ports + DB so a restart can rebind).
    Shutdown,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum NodeEvent {
    Listening { addr: String },
    InvitationReceived { room: String, host: String },
    RoomReady { room: String, peer: String, we_are_host: bool, epoch: u64 },
    Message { room: String, sender: String, body: String, epoch: u64 },
    ApprovalRequested { room: String, peer: String },
    Rotated { room: String, new_epoch: u64 },
    ConnectionStateChanged { peer: String, connected: bool },
    Log { message: String },
}

#[derive(Clone)]
pub struct NodeHandle {
    pub cmd_tx: mpsc::Sender<Command>,
    pub peer_id: PeerId,
}

pub struct NodeConfig {
    pub data_dir: std::path::PathBuf,
    pub hub_base: Option<String>,
    pub listen_quic: Option<u16>,
    pub listen_tcp: Option<u16>,
    pub auto_approve: bool,
    /// Offline mode: skip hub registration entirely.
    pub offline: bool,
    /// Offer relay service and reserve with reachable peers (default true).
    pub relay_enabled: bool,
    /// Force this node to accept relay reservations even without detected
    /// external addresses (port-forwarded hosts, tests).
    pub force_relay_hop: bool,
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            data_dir: std::env::temp_dir().join("onlyhumans"),
            hub_base: None,
            listen_quic: Some(0),
            listen_tcp: Some(0),
            auto_approve: false,
            offline: false,
            relay_enabled: true,
            force_relay_hop: false,
        }
    }
}

pub async fn spawn(
    cfg: NodeConfig,
    mut event_tx: mpsc::UnboundedSender<NodeEvent>,
) -> anyhow::Result<NodeHandle> {
    let identity = Identity::load_or_create(&cfg.data_dir)?;
    let store = Store::open(&cfg.data_dir)?;
    let peer_id = identity.peer_id();
    let hub = HubClient::new(cfg.hub_base.as_deref().unwrap_or(crate::hub::DEFAULT_HUB));

    let mut swarm = libp2p::SwarmBuilder::with_existing_identity(identity.keypair().clone())
        .with_tokio()
        .with_tcp(
            libp2p::tcp::Config::default().nodelay(true),
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )?
        .with_quic()
        .with_relay_client(
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )?
        .with_behaviour(|key, relay_client| {
            let identify = identify::Behaviour::new(identify::Config::new(
                "onlyhumans/1".to_string(),
                key.public(),
            ));
            let ping = ping::Behaviour::new(ping::Config::new());
            let relay = relay::Behaviour::new(
                key.public().to_peer_id(),
                relay::Config::default(),
            );
            let dcutr = dcutr::Behaviour::new(key.public().to_peer_id());
            let rooms = request_response::Behaviour::with_codec(
                EnvelopeCodec,
                [(ROOM_PROTOCOL.to_string(), ProtocolSupport::Full)],
                request_response::Config::default()
                    .with_request_timeout(Duration::from_secs(30))
                    .with_max_concurrent_streams(64),
            );
            Behaviour {
                identify,
                ping,
                relay_client,
                relay,
                dcutr,
                rooms,
            }
        })?
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(600)))
        .build();

    if let Some(port) = cfg.listen_quic {
        swarm.listen_on(
            Multiaddr::empty()
                .with(Protocol::from("0.0.0.0".parse::<std::net::Ipv4Addr>().unwrap()))
                .with(Protocol::Udp(port))
                .with(Protocol::QuicV1),
        )?;
    }
    if cfg.force_relay_hop {
        swarm
            .behaviour_mut()
            .relay
            .set_status(Some(relay::Status::Enable));
    }
    if let Some(port) = cfg.listen_tcp {
        swarm.listen_on(
            Multiaddr::empty()
                .with(Protocol::from("0.0.0.0".parse::<std::net::Ipv4Addr>().unwrap()))
                .with(Protocol::Tcp(port)),
        )?;
    }

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<Command>(64);

    let mut rooms = Rooms::new(crate::global_key(), identity.id_string());
    rooms.auto_approve = cfg.auto_approve;

    // Restore persisted conversations so chats survive restarts.
    if let Ok(convs) = store.conversations() {
        for c in convs {
            let Ok(peer) = libp2p::PeerId::from_str(&c.peer_id) else {
                continue;
            };
            let role = if c.is_host {
                crate::rooms::Role::Host
            } else {
                crate::rooms::Role::Guest
            };
            if let Ok(Some((key, epoch))) = store.room_state(&c.room_id_hex) {
                rooms.restore_room(&c.room_id_hex, peer, role, key, epoch);
            }
        }
    }

    let mut known_peers: HashMap<String, PeerId> = HashMap::new();
    /// Direct addresses of peers we can potentially reserve with.
    let mut relay_candidates: HashMap<PeerId, Multiaddr> = HashMap::new();
    /// Full circuit addresses from accepted reservations.
    let mut circuit_addrs: Vec<Multiaddr> = Vec::new();
    let mut outbox: HashMap<PeerId, VecDeque<Envelope>> = HashMap::new();
    let mut connected: HashMap<PeerId, bool> = HashMap::new();

    // Track rooms we host per peer so commands can find the room hex.
    let mut hosted_for_peer: HashMap<PeerId, String> = HashMap::new();

    // The interval's first tick races listener binding, so retry fast until
    // the first successful registration, then refresh on the slow cadence.
    let mut hub_fast = tokio::time::interval(Duration::from_secs(2));
    hub_fast.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut hub_interval = tokio::time::interval(Duration::from_secs(120));
    hub_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut hub_registered = false;
    let mut query_interval = tokio::time::interval(Duration::from_secs(90));

    // rusqlite's Connection is !Sync; a std Mutex makes the task Send.
    let store = std::sync::Mutex::new(store);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(cmd) = cmd_rx.recv() => {
                    if matches!(cmd, Command::Shutdown) {
                        break;
                    }
                    handle_command(
                        &mut swarm,
                        &mut rooms,
                        &store,
                        &mut relay_candidates,
                        &mut circuit_addrs,
                        &cmd,
                        &identity,
                        &hub,
                        &mut known_peers,
                        &mut outbox,
                        &mut hosted_for_peer,
                        &cfg,
                        &mut event_tx,
                    ).await;
                }
                _ = hub_fast.tick(), if !cfg.offline && !hub_registered => {
                    match register_with_hub(&mut swarm, &identity, &hub, &circuit_addrs).await {
                        Ok(()) => {
                            hub_registered = true;
                            // The slow interval's immediate first tick would
                            // re-register within the hub's 30s per-peer
                            // rate limit; reset pushes the next refresh a
                            // full period out.
                            hub_interval.reset();
                        }
                        Err(e) => {
                            let _ = event_tx.send(NodeEvent::Log { message: format!("hub register: {e}") });
                        }
                    }
                }
                _ = hub_interval.tick(), if !cfg.offline && hub_registered => {
                    if let Err(e) = register_with_hub(&mut swarm, &identity, &hub, &circuit_addrs).await {
                        let _ = event_tx.send(NodeEvent::Log { message: format!("hub register: {e}") });
                    }
                }
                _ = query_interval.tick() => {
                    // Poll contacts for rooms they host for us.
                    for peer in known_peers.values().copied().collect::<Vec<_>>() {
                        enqueue(&mut outbox, peer, Envelope::QueryRooms);
                        flush_outbox(&mut swarm, &mut outbox, peer);
                    }
                    // Retry hub-based dials for peers with undelivered
                    // envelopes (e.g. the peer had not registered yet when
                    // the conversation was opened).
                    for peer in outbox.keys().copied().collect::<Vec<_>>() {
                        if !swarm.is_connected(&peer) {
                            dial_peer(&mut swarm, &hub, &identity, peer, &cfg, &mut event_tx).await;
                        }
                    }
                }
                ev = swarm.select_next_some() => {
                    handle_swarm_event(
                        &mut swarm,
                        &mut rooms,
                        ev,
                        &store,
                        &mut outbox,
                        &mut connected,
                        &mut relay_candidates,
                        &mut circuit_addrs,
                        cfg.relay_enabled,
                        &mut event_tx,
                    );
                }
            }
        }
    });

    Ok(NodeHandle { cmd_tx, peer_id })
}

fn enqueue(outbox: &mut HashMap<PeerId, VecDeque<Envelope>>, peer: PeerId, env: Envelope) {
    outbox.entry(peer).or_default().push_back(env);
}

fn flush_outbox(swarm: &mut Swarm<Behaviour>, outbox: &mut HashMap<PeerId, VecDeque<Envelope>>, peer: PeerId) {
    if !swarm.is_connected(&peer) {
        return;
    }
    if let Some(q) = outbox.get_mut(&peer) {
        while let Some(env) = q.pop_front() {
            swarm
                .behaviour_mut()
                .rooms
                .send_request(&peer, env);
        }
    }
}

/// Flush pending envelopes to `peer` — or, when we are not connected,
/// start a hub-based redial immediately instead of letting them sit in
/// the outbox until the 90 s tick. Reconnection flushes via
/// ConnectionEstablished.
async fn flush_or_redial(
    swarm: &mut Swarm<Behaviour>,
    hub: &HubClient,
    identity: &Identity,
    cfg: &NodeConfig,
    event_tx: &mpsc::UnboundedSender<NodeEvent>,
    outbox: &mut HashMap<PeerId, VecDeque<Envelope>>,
    peer: PeerId,
) {
    if swarm.is_connected(&peer) {
        flush_outbox(swarm, outbox, peer);
    } else {
        dial_peer(swarm, hub, identity, peer, cfg, event_tx).await;
    }
}

async fn register_with_hub(
    swarm: &mut Swarm<Behaviour>,
    identity: &Identity,
    hub: &HubClient,
    circuit_addrs: &[Multiaddr],
) -> anyhow::Result<()> {
    let my_ip = default_route_ip();
    let mut addrs = Vec::new();
    for l in swarm.listeners() {
        // Rewrite 0.0.0.0 placeholders to our best local address.
        let components: Vec<libp2p::multiaddr::Protocol<'_>> = l.iter().collect();
        let mut ma = Multiaddr::empty();
        for c in components {
            match c {
                Protocol::Ip4(ip) if ip.is_unspecified() => {
                    ma.push(Protocol::from(my_ip));
                }
                other => ma.push(other),
            }
        }
        addrs.push(ma.to_string());
    }
    for c in circuit_addrs {
        addrs.push(c.to_string());
    }
    if addrs.is_empty() {
        anyhow::bail!("no listening addresses yet");
    }
    hub.register(identity, addrs).await
}

fn circuit_addrs_contain(list: &[Multiaddr], addr: &Multiaddr) -> bool {
    list.iter().any(|a| a == addr)
}

fn default_route_ip() -> std::net::Ipv4Addr {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| match a.ip() {
            std::net::IpAddr::V4(v4) => v4,
            std::net::IpAddr::V6(_) => "127.0.0.1".parse().unwrap(),
        })
        .unwrap_or_else(|_| "127.0.0.1".parse().unwrap())
}

#[allow(clippy::too_many_arguments)]
async fn handle_command(
    swarm: &mut Swarm<Behaviour>,
    rooms: &mut Rooms,
    store: &std::sync::Mutex<Store>,
    relay_candidates: &mut HashMap<PeerId, Multiaddr>,
    circuit_addrs: &mut Vec<Multiaddr>,
    cmd: &Command,
    identity: &Identity,
    hub: &HubClient,
    known_peers: &mut HashMap<String, PeerId>,
    outbox: &mut HashMap<PeerId, VecDeque<Envelope>>,
    hosted_for_peer: &mut HashMap<PeerId, String>,
    cfg: &NodeConfig,
    event_tx: &mpsc::UnboundedSender<NodeEvent>,
) {
    match cmd {
        // Handled by the run loop (breaks the select); unreachable here.
        Command::Shutdown => {}
        Command::OpenConversation { peer } => {
            let Ok(pid) = PeerId::from_str(peer) else {
                let _ = event_tx.send(NodeEvent::Log { message: format!("invalid peer id: {peer}") });
                return;
            };
            known_peers.insert(peer.clone(), pid);
            let (room_hex, ev) = rooms.host_open_room(pid);
            hosted_for_peer.insert(pid, room_hex);
            if let RoomEvent::Send { peer: to, envelope } = ev {
                enqueue(outbox, to, envelope);
            }
            // Not just a dial: when a connection already exists (e.g. the
            // peers auto-connected at startup), dial_peer would early-return
            // and the enqueued Invite would sit in the outbox until the 90 s
            // tick. Flushing directly covers the already-connected case.
            flush_or_redial(swarm, hub, identity, cfg, event_tx, outbox, pid).await;
        }
        Command::Dial { addr } => {
            if let Err(e) = swarm.dial(addr.clone()) {
                let _ = event_tx.send(NodeEvent::Log { message: format!("dial failed: {e}") });
            }
        }
        Command::SendMessage { room, text } => {
            if let Some(frame) = rooms.seal_chat(room, text.as_bytes()) {
                if let Some(st) = rooms.room(room) {
                    let peer = st.peer;
                    enqueue(
                        outbox,
                        peer,
                        Envelope::Chat { frame },
                    );
                    flush_or_redial(swarm, hub, identity, cfg, event_tx, outbox, peer).await;
                }
            } else {
                let _ = event_tx.send(NodeEvent::Log {
                    message: format!(
                        "cannot send in {room}: no key yet (still joining) or unknown room"
                    ),
                });
            }
        }
        Command::Rotate { room } => {
            if let Some(frame) = rooms.rotate(room) {
                if let Some(st) = rooms.room(room) {
                    let _ = store.lock().unwrap().upsert_conversation(
                        room,
                        &st.peer.to_string(),
                        st.role == crate::rooms::Role::Host,
                        st.crypto.room_key(),
                        st.crypto.epoch,
                    );
                }
                if let Some(st) = rooms.room(room) {
                    let peer = st.peer;
                    enqueue(outbox, peer, Envelope::Rotate { frame });
                    flush_or_redial(swarm, hub, identity, cfg, event_tx, outbox, peer).await;
                }
            }
        }
        Command::Approve { peer, room } => {
            if let Ok(pid) = PeerId::from_str(peer) {
                for ev in rooms.deliver_key_to(room, pid) {
                    if let RoomEvent::Send { peer: to, envelope } = ev {
                        enqueue(outbox, to, envelope);
                    }
                }
                flush_or_redial(swarm, hub, identity, cfg, event_tx, outbox, pid).await;
            }
        }
        Command::Query { peer } => {
            if let Ok(pid) = PeerId::from_str(peer) {
                enqueue(outbox, pid, Envelope::QueryRooms);
                flush_or_redial(swarm, hub, identity, cfg, event_tx, outbox, pid).await;
            }
        }
        Command::AcceptInvitation { room, host } => {
            if let Ok(host_pid) = PeerId::from_str(&host) {
                if let Some(RoomEvent::Send { peer, envelope }) =
                    rooms.accept_invitation(&room, host_pid)
                {
                    enqueue(outbox, peer, envelope);
                }
                flush_or_redial(swarm, hub, identity, cfg, event_tx, outbox, host_pid).await;
            }
        }
        Command::ReserveWith { addr } => {
            if let Some(Protocol::P2p(relay_id)) = addr.iter().last() {
                let mut base = addr.clone();
                base.pop(); // drop /p2p/<relay>
                try_reserve(swarm, relay_candidates, circuit_addrs, relay_id, base);
            } else {
                let _ = event_tx.send(NodeEvent::Log {
                    message: "ReserveWith requires an address ending in /p2p/<relay_id>".into(),
                });
            }
        }
    }
}

/// Attempt a relay reservation with `relay_id` reachable at `base` (no /p2p suffix).
fn try_reserve(
    swarm: &mut Swarm<Behaviour>,
    relay_candidates: &mut HashMap<PeerId, Multiaddr>,
    circuit_addrs: &mut Vec<Multiaddr>,
    relay_id: PeerId,
    base: Multiaddr,
) {
    let circuit = base
        .clone()
        .with(Protocol::P2p(relay_id))
        .with(Protocol::P2pCircuit);
    // circuit_addrs doubles as the "attempted" set: a second listen_on for
    // the same circuit aborts the first reservation's in-flight request.
    if circuit_addrs_contain(circuit_addrs, &circuit) {
        return;
    }
    circuit_addrs.push(circuit.clone());
    relay_candidates.insert(relay_id, base);
    if let Err(e) = swarm.listen_on(circuit.clone()) {
        eprintln!("[onlyhumans] relay reservation not started: {e}");
    }
}

async fn dial_peer(
    swarm: &mut Swarm<Behaviour>,
    hub: &HubClient,
    identity: &Identity,
    pid: PeerId,
    cfg: &NodeConfig,
    event_tx: &mpsc::UnboundedSender<NodeEvent>,
) {
    if swarm.is_connected(&pid) {
        return;
    }
    if !cfg.offline {
        if let Ok(Some(reg)) = hub.lookup(&pid.to_string()).await {
            for a in &reg.addrs {
                if let Ok(ma) = a.parse::<Multiaddr>() {
                    let mut ma = ma;
                    // A peer's published circuit address is
                    // .../p2p/<relay>/p2p-circuit; dialing THEM through it
                    // requires appending /p2p/<target>.
                    let is_bare_circuit = ma.iter().last() == Some(Protocol::P2pCircuit);
                    if is_bare_circuit {
                        ma = ma.with(Protocol::P2p(pid));
                    }
                    let _ = swarm.dial(ma);
                }
            }
            let _ = identity; // signature already verified inside lookup
        }
    }
    let _ = event_tx;
}

#[allow(clippy::too_many_arguments)]
fn handle_swarm_event(
    swarm: &mut Swarm<Behaviour>,
    rooms: &mut Rooms,
    ev: SwarmEvent<BehaviourEvent>,
    store: &std::sync::Mutex<Store>,
    outbox: &mut HashMap<PeerId, VecDeque<Envelope>>,
    connected: &mut HashMap<PeerId, bool>,
    relay_candidates: &mut HashMap<PeerId, Multiaddr>,
    circuit_addrs: &mut Vec<Multiaddr>,
    relay_enabled: bool,
    event_tx: &mpsc::UnboundedSender<NodeEvent>,
) {
    match ev {
        SwarmEvent::NewListenAddr { address, .. } => {
            if address.iter().any(|p| matches!(p, Protocol::P2pCircuit)) {
                eprintln!("[onlyhumans] circuit listener up: {address}");
            }
            let _ = event_tx.send(NodeEvent::Listening { addr: address.to_string() });
        }
        SwarmEvent::ConnectionEstablished { peer_id, .. } => {
            connected.insert(peer_id, true);
            let _ = event_tx.send(NodeEvent::ConnectionStateChanged {
                peer: peer_id.to_string(),
                connected: true,
            });
            flush_outbox(swarm, outbox, peer_id);
        }
        SwarmEvent::ConnectionClosed { peer_id, .. } => {
            connected.insert(peer_id, false);
            let _ = event_tx.send(NodeEvent::ConnectionStateChanged {
                peer: peer_id.to_string(),
                connected: false,
            });
        }
        SwarmEvent::Behaviour(BehaviourEvent::RelayClient(relay::client::Event::ReservationReqAccepted {
            relay_peer_id,
            ..
        })) => {
            // Record the full dialable circuit address for the hub.
            // circuit_addrs already contains the attempted circuit from
            // try_reserve; nothing to add — just log the confirmation.
            let _ = event_tx.send(NodeEvent::Log {
                message: format!("relay reservation accepted via {relay_peer_id}"),
            });
        }
        SwarmEvent::Behaviour(BehaviourEvent::Relay(relay::Event::ReservationReqAccepted { src_peer_id, .. })) => {
            let _ = event_tx.send(NodeEvent::Log {
                message: format!("now relaying for {src_peer_id}"),
            });
        }
        SwarmEvent::Behaviour(BehaviourEvent::Relay(relay::Event::ReservationReqDenied { src_peer_id, status })) => {
            eprintln!("[onlyhumans] relay server: reservation DENIED from {src_peer_id}, status {status:?}");
        }
        SwarmEvent::Behaviour(BehaviourEvent::Rooms(rr_ev)) => match rr_ev {
            request_response::Event::Message { peer, message, .. } => {
                match message {
                    request_response::Message::Request { request, channel, .. } => {
                        let is_contact = store.lock().unwrap().is_contact(&peer.to_string());
                        let events = rooms.handle(peer, request, is_contact);
                        persist_room_state(rooms, &store, &peer, &events);
                        for ev in events {
                            dispatch_room_event(swarm, outbox, &peer, ev, event_tx);
                        }
                        // Always acknowledge requests.
                        let _ = swarm
                            .behaviour_mut()
                            .rooms
                            .send_response(channel, Envelope::Ack);
                    }
                    request_response::Message::Response { response, .. } => {
                        let is_contact = store.lock().unwrap().is_contact(&peer.to_string());
                        let events = rooms.handle(peer, response, is_contact);
                        persist_room_state(rooms, &store, &peer, &events);
                        for ev in events {
                            dispatch_room_event(swarm, outbox, &peer, ev, event_tx);
                        }
                    }
                }
            }
            request_response::Event::OutboundFailure { peer, error, .. } => {
                let _ = event_tx.send(NodeEvent::Log {
                    message: format!("outbound to {peer} failed: {error}"),
                });
            }
            request_response::Event::InboundFailure { peer, error, .. } => {
                let _ = event_tx.send(NodeEvent::Log {
                    message: format!("inbound from {peer} failed: {error}"),
                });
            }
            _ => {}
        },
        SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received {
            peer_id,
            info,
            ..
        })) => {
            // Learning our own observed address is what auto-enables our
            // relay service (HOP) once we are publicly reachable — the
            // official relay-server pattern.
            let observed = info.observed_addr.clone();
            if swarm.external_addresses().all(|a| a != &observed) {
                swarm.add_external_address(observed);
            }
            // Learn addresses for future dials and relay reservations.
            for ma in info.listen_addrs {
                let usable = ma.iter().any(|p| {
                    matches!(p, Protocol::Ip4(ip) if !ip.is_loopback() && !ip.is_unspecified())
                });
                if !usable {
                    continue;
                }
                if !swarm.is_connected(&peer_id) {
                    let _ = swarm.dial(ma.clone().with(Protocol::P2p(peer_id)));
                }
                if relay_enabled {
                    try_reserve(swarm, relay_candidates, circuit_addrs, peer_id, ma);
                }
            }
        }
        _ => {}
    }
}

/// Persist room key/epoch whenever a room becomes ready or rotates.
fn persist_room_state(
    rooms: &mut Rooms,
    store: &std::sync::Mutex<Store>,
    peer: &libp2p::PeerId,
    events: &[RoomEvent],
) {
    use crate::rooms::Role;
    for ev in events {
        let hex = match ev {
            RoomEvent::RoomReady { room_id_hex, .. } => room_id_hex.clone(),
            RoomEvent::Rotated { room_id_hex, .. } => room_id_hex.clone(),
            _ => continue,
        };
        if let Some(st) = rooms.room(&hex) {
            let is_host = st.role == Role::Host;
            let epoch = st.crypto.epoch;
            let key = *st.crypto.room_key();
            let _ = store
                .lock()
                .unwrap()
                .upsert_conversation(&hex, &peer.to_string(), is_host, &key, epoch);
        }
    }
}

fn dispatch_room_event(
    swarm: &mut Swarm<Behaviour>,
    outbox: &mut HashMap<PeerId, VecDeque<Envelope>>,
    from: &PeerId,
    ev: RoomEvent,
    event_tx: &mpsc::UnboundedSender<NodeEvent>,
) {
    match ev {
        RoomEvent::Send { peer, envelope } => {
            enqueue(outbox, peer, envelope);
            flush_outbox(swarm, outbox, peer);
        }
        RoomEvent::RoomReady { room_id_hex, peer, role, epoch } => {
            let _ = event_tx.send(NodeEvent::RoomReady {
                room: room_id_hex,
                peer: peer.to_string(),
                we_are_host: role == crate::rooms::Role::Host,
                epoch,
            });
        }
        RoomEvent::Message { room_id_hex, sender, body, epoch } => {
            let _ = event_tx.send(NodeEvent::Message {
                room: room_id_hex,
                sender,
                body: String::from_utf8_lossy(&body).into_owned(),
                epoch,
            });
        }
        RoomEvent::InvitationReceived { room_id_hex, host } => {
            let _ = event_tx.send(NodeEvent::InvitationReceived {
                room: room_id_hex,
                host: host.to_string(),
            });
        }
        RoomEvent::ApprovalRequested { room_id_hex, peer } => {
            let _ = event_tx.send(NodeEvent::ApprovalRequested {
                room: room_id_hex,
                peer: peer.to_string(),
            });
        }
        RoomEvent::Rotated { room_id_hex, new_epoch } => {
            let _ = event_tx.send(NodeEvent::Rotated { room: room_id_hex, new_epoch });
        }
        RoomEvent::ProtocolError { context } => {
            let _ = event_tx.send(NodeEvent::Log { message: context });
        }
    }
    let _ = from;
}
