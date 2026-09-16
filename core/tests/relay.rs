//! Connectivity proof: a chat delivered entirely through a peer relay.
//!
//! Topology (all in-process, real libp2p transports):
//!
//!   R = relay node (offers HOP service)
//!   B = peer reachable ONLY via the relay (reserves a circuit through R)
//!   A = conversation host, dials B's circuit address
//!
//! A --(circuit via R)--> B must complete the full room lifecycle.

use onlyhumans_core::net::{spawn, Command, NodeConfig, NodeEvent};
use std::time::Duration;
use tokio::sync::mpsc;

async fn next_event(rx: &mut mpsc::UnboundedReceiver<NodeEvent>, want: &str) -> NodeEvent {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("timed out waiting for event")
            .expect("node task died");
        let kind = match &ev {
            NodeEvent::Listening { .. } => "listening",
            NodeEvent::RoomReady { .. } => "room_ready",
            NodeEvent::Message { .. } => "message",
            NodeEvent::ApprovalRequested { .. } => "approval",
            NodeEvent::Rotated { .. } => "rotated",
            NodeEvent::ConnectionStateChanged { .. } => "conn",
            NodeEvent::Log { .. } => "log",
        };
        eprintln!("  [{want}] {kind}: {ev:?}");
        if kind == want {
            return ev;
        }
    }
}

async fn wait_for_log(
    rx: &mut mpsc::UnboundedReceiver<NodeEvent>,
    needle: &str,
) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv()).await;
        match ev {
            Err(_) => return false,
            Ok(None) => return false,
            Ok(Some(NodeEvent::Log { message })) => {
                eprintln!("  [log] {message}");
                if message.contains(needle) {
                    return true;
                }
            }
            Ok(Some(other)) => {
                eprintln!("  [log-skipped] {other:?}");
            }
        }
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("oh-relay-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[tokio::test]
async fn chat_through_peer_relay() {
    // --- Relay node R: fixed TCP port, forced HOP service ---
    let (r_tx, mut r_rx) = mpsc::unbounded_channel();
    let r = spawn(
        NodeConfig {
            data_dir: temp_dir("r"),
            offline: true,
            force_relay_hop: true,
            listen_quic: None,
            ..Default::default()
        },
        r_tx,
    )
    .await
    .unwrap();
    let r_addr = loop {
        match next_event(&mut r_rx, "listening").await {
            NodeEvent::Listening { addr } => break addr,
            _ => continue,
        }
    };

    // --- B: no reachable listener of its own; reserves through R ---
    let (b_tx, mut b_rx) = mpsc::unbounded_channel();
    let b = spawn(
        NodeConfig {
            data_dir: temp_dir("b"),
            offline: true,
            // B has listeners on localhost in reality; the point is that A
            // will reach it ONLY via the circuit address.
            listen_quic: None,
            ..Default::default()
        },
        b_tx,
    )
    .await
    .unwrap();
    // B connects to R directly, then reserves a circuit through it.
    let dial = format!("{r_addr}/p2p/{}", r.peer_id);
    b.cmd_tx
        .send(Command::Dial { addr: dial.parse().unwrap() })
        .await
        .unwrap();
    // Let the identify exchange complete first: the relay enables its HOP
    // service only after learning an observed (external) address.
    tokio::time::sleep(Duration::from_secs(3)).await;
    b.cmd_tx
        .send(Command::ReserveWith { addr: dial.parse().unwrap() })
        .await
        .unwrap();
    assert!(
        wait_for_log(&mut b_rx, "relay reservation accepted").await,
        "B never obtained a relay reservation"
    );

    // --- A: host of the conversation; dials B through the circuit ---
    let (a_tx, mut a_rx) = mpsc::unbounded_channel();
    let a = spawn(
        NodeConfig {
            data_dir: temp_dir("a"),
            offline: true,
            auto_approve: true,
            ..Default::default()
        },
        a_tx,
    )
    .await
    .unwrap();
    a.cmd_tx
        .send(Command::OpenConversation { peer: b.peer_id.to_string() })
        .await
        .unwrap();
    let circuit = format!("{r_addr}/p2p/{}/p2p-circuit/p2p/{}", r.peer_id, b.peer_id);
    a.cmd_tx
        .send(Command::Dial { addr: circuit.parse().unwrap() })
        .await
        .unwrap();

    // --- The full handshake over the relayed connection ---
    let a_ready = next_event(&mut a_rx, "room_ready").await;
    let b_ready = next_event(&mut b_rx, "room_ready").await;
    let room = match a_ready {
        NodeEvent::RoomReady { room, we_are_host: true, .. } => room,
        other => panic!("A should be host, got {other:?}"),
    };
    assert!(
        matches!(&b_ready, NodeEvent::RoomReady { room: rr, we_are_host: false, .. } if *rr == room),
        "B should be guest in the same room, got {b_ready:?}"
    );

    // --- Chat both ways through the relay ---
    a.cmd_tx
        .send(Command::SendMessage { room: room.clone(), text: "hello via relay".into() })
        .await
        .unwrap();
    match next_event(&mut b_rx, "message").await {
        NodeEvent::Message { body, .. } => assert_eq!(body, "hello via relay"),
        other => panic!("expected message, got {other:?}"),
    }
    b.cmd_tx
        .send(Command::SendMessage { room, text: "relayed back".into() })
        .await
        .unwrap();
    match next_event(&mut a_rx, "message").await {
        NodeEvent::Message { body, .. } => assert_eq!(body, "relayed back"),
        other => panic!("expected reply, got {other:?}"),
    }

    // The relay node itself must never see plaintext (it only shuffles
    // already-encrypted frames) — structurally true by design; nothing to
    // assert at runtime here beyond the relayed exchange having worked.
}
