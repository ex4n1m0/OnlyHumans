//! M1 milestone proof: two full nodes in one process, over real libp2p
//! QUIC on localhost, completing the entire protocol:
//! host opens room -> Invite -> Join (GK proofs) -> KeyDelivery ->
//! chat both directions -> host rotation -> chat continues under new key.

use onlyhumans_core::net::{spawn, Command, NodeConfig, NodeEvent};
use std::time::Duration;
use tokio::sync::mpsc;

async fn next_event(rx: &mut mpsc::UnboundedReceiver<NodeEvent>, want: &str) -> NodeEvent {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("timed out waiting for event")
            .expect("node task died");
        let kind = match &ev {
            NodeEvent::Listening { .. } => "listening",
            NodeEvent::InvitationReceived { .. } => "invitation",
            NodeEvent::RoomReady { .. } => "room_ready",
            NodeEvent::Message { .. } => "message",
            NodeEvent::ApprovalRequested { .. } => "approval",
            NodeEvent::Rotated { .. } => "rotated",
            NodeEvent::ConnectionStateChanged { .. } => "conn",
            NodeEvent::Log { .. } => "log",
        };
        eprintln!("  [{want}] got {kind}: {ev:?}");
        if kind == want {
            return ev;
        }
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("oh-m1-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// Non-blocking snapshot of events waiting in the channel.
async fn drain_pending(rx: &mut mpsc::UnboundedReceiver<NodeEvent>) -> Vec<NodeEvent> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(ev);
    }
    out
}

#[tokio::test]
async fn two_nodes_full_room_lifecycle() {
    // Node B (guest) listens on a fixed QUIC port so A can dial it.
    let b_dir = temp_dir("b");
    let (b_tx, mut b_rx) = mpsc::unbounded_channel();
    let b = spawn(
        NodeConfig {
            data_dir: b_dir,
            offline: true,
            ..Default::default()
        },
        b_tx,
    )
    .await
    .unwrap();

    // Capture B's QUIC listen address.
    let b_addr = loop {
        match next_event(&mut b_rx, "listening").await {
            NodeEvent::Listening { addr } if addr.contains("quic") => break addr,
            _ => continue,
        }
    };

    // Node A (host, conversation initiator).
    let a_dir = temp_dir("a");
    let (a_tx, mut a_rx) = mpsc::unbounded_channel();
    let a = spawn(
        NodeConfig {
            data_dir: a_dir,
            offline: true,
            auto_approve: true, // host admits the guest without UI
            ..Default::default()
        },
        a_tx,
    )
    .await
    .unwrap();

    // A opens a conversation with B (creates the room, queues the Invite)
    // and dials B directly (offline mode: no hub lookup).
    a.cmd_tx
        .send(Command::OpenConversation { peer: b.peer_id.to_string() })
        .await
        .unwrap();
    let dial_addr = format!("{b_addr}/p2p/{}", b.peer_id);
    a.cmd_tx
        .send(Command::Dial { addr: dial_addr.parse().unwrap() })
        .await
        .unwrap();

    // --- B consents to the invitation, then the handshake completes ---
    let invite = next_event(&mut b_rx, "invitation").await;
    let (room_hex, host) = match invite {
        NodeEvent::InvitationReceived { room, host } => (room, host),
        other => panic!("expected invitation, got {other:?}"),
    };
    b.cmd_tx
        .send(Command::AcceptInvitation { room: room_hex, host })
        .await
        .unwrap();

    let a_ready = next_event(&mut a_rx, "room_ready").await;
    let b_ready = next_event(&mut b_rx, "room_ready").await;
    let room = match a_ready {
        NodeEvent::RoomReady { room, we_are_host: true, .. } => room,
        other => panic!("A should be host, got {other:?}"),
    };
    match &b_ready {
        NodeEvent::RoomReady { room: r, we_are_host: false, .. } if r == &room => {}
        other => panic!("B should be guest in the same room, got {other:?}"),
    }

    // --- Chat: A -> B ---
    a.cmd_tx
        .send(Command::SendMessage { room: room.clone(), text: "hello from host".into() })
        .await
        .unwrap();
    let msg = next_event(&mut b_rx, "message").await;
    match msg {
        NodeEvent::Message { body, sender, epoch, .. } => {
            assert_eq!(body, "hello from host");
            assert_eq!(sender, a.peer_id.to_string());
            assert_eq!(epoch, 1);
        }
        other => panic!("expected message, got {other:?}"),
    }

    // --- Chat: B -> A (guest can send too) ---
    b.cmd_tx
        .send(Command::SendMessage { room: room.clone(), text: "hi from guest".into() })
        .await
        .unwrap();
    let msg = next_event(&mut a_rx, "message").await;
    match msg {
        NodeEvent::Message { body, sender, .. } => {
            assert_eq!(body, "hi from guest");
            assert_eq!(sender, b.peer_id.to_string());
        }
        other => panic!("expected message, got {other:?}"),
    }

    // --- Host rotates the key; guest applies it ---
    a.cmd_tx
        .send(Command::Rotate { room: room.clone() })
        .await
        .unwrap();
    let rotated = next_event(&mut b_rx, "rotated").await;
    match rotated {
        NodeEvent::Rotated { new_epoch, .. } => assert_eq!(new_epoch, 2),
        other => panic!("expected rotation, got {other:?}"),
    }

    // --- Chat continues under the new key ---
    a.cmd_tx
        .send(Command::SendMessage { room: room.clone(), text: "after rotation".into() })
        .await
        .unwrap();
    let msg = next_event(&mut b_rx, "message").await;
    match msg {
        NodeEvent::Message { body, epoch, .. } => {
            assert_eq!(body, "after rotation");
            assert_eq!(epoch, 2, "message must carry the new epoch");
        }
        other => panic!("expected post-rotation message, got {other:?}"),
    }

    // --- Second rotation, then B replies (guest under epoch 3) ---
    a.cmd_tx.send(Command::Rotate { room }).await.unwrap();
    let rotated = next_event(&mut b_rx, "rotated").await;
    let r3room = match rotated {
        NodeEvent::Rotated { room, new_epoch } => {
            assert_eq!(new_epoch, 3);
            room
        }
        other => panic!("expected second rotation, got {other:?}"),
    };

    // --- Resume cycle: re-opening the conversation must REUSE the room and
    // must NOT re-prompt the guest (the host's periodic QueryRooms
    // re-invite takes this same path).
    a.cmd_tx
        .send(Command::OpenConversation { peer: b.peer_id.to_string() })
        .await
        .unwrap();
    // Give the envelope round-trip time to land, then prove liveness with
    // a chat under the still-current key.
    a.cmd_tx
        .send(Command::SendMessage { room: r3room.clone(), text: "resume ok".into() })
        .await
        .unwrap();
    let msg = next_event(&mut b_rx, "message").await;
    match msg {
        NodeEvent::Message { body, epoch, .. } => {
            assert_eq!(body, "resume ok");
            assert_eq!(epoch, 3);
        }
        other => panic!("expected post-resume message, got {other:?}"),
    }
    // No fresh invitation may be pending on B: consent was already given,
    // so the re-invite auto-re-Joins silently.
    let pending = drain_pending(&mut b_rx).await;
    assert!(
        !pending
            .iter()
            .any(|ev| matches!(ev, NodeEvent::InvitationReceived { .. })),
        "re-open must not re-prompt the guest, got {pending:?}"
    );
    // And the host reused the SAME room (B's auto re-Join made the host
    // re-deliver, which emits RoomReady for the same room id).
    let a_ready2 = next_event(&mut a_rx, "room_ready").await;
    match a_ready2 {
        NodeEvent::RoomReady { room, we_are_host: true, .. } => {
            assert_eq!(room, r3room, "re-open must reuse the existing room");
        }
        other => panic!("expected host RoomReady on resume, got {other:?}"),
    }
}
