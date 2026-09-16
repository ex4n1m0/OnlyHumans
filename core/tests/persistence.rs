//! Restart proof: a host that stops and restarts (same data dir) restores
//! its rooms from the encrypted store — same identity, same room key — and
//! the conversation continues without a new invitation round.

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
    let d = std::env::temp_dir().join(format!("oh-persist-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[tokio::test]
async fn host_room_survives_restart() {
    // B (guest) on a fixed profile; we keep it running across A's restart.
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
    let b_addr = loop {
        match next_event(&mut b_rx, "listening").await {
            NodeEvent::Listening { addr } if addr.contains("quic") => break addr,
            _ => continue,
        }
    };

    // A (host) — profile reused across the restart below.
    let a_dir = temp_dir("a");
    let (a_tx, mut a_rx) = mpsc::unbounded_channel();
    let a = spawn(
        NodeConfig {
            data_dir: a_dir.clone(),
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
    a.cmd_tx
        .send(Command::Dial {
            addr: format!("{b_addr}/p2p/{}", b.peer_id).parse().unwrap(),
        })
        .await
        .unwrap();

    // Consent + handshake.
    let invite = next_event(&mut b_rx, "invitation").await;
    let (room_hex, host) = match invite {
        NodeEvent::InvitationReceived { room, host } => (room, host),
        other => panic!("expected invitation, got {other:?}"),
    };
    b.cmd_tx
        .send(Command::AcceptInvitation { room: room_hex.clone(), host })
        .await
        .unwrap();
    match next_event(&mut a_rx, "room_ready").await {
        NodeEvent::RoomReady { room, we_are_host: true, .. } => assert_eq!(room, room_hex),
        other => panic!("A should be host, got {other:?}"),
    }
    let _ = next_event(&mut b_rx, "room_ready").await;

    a.cmd_tx
        .send(Command::SendMessage { room: room_hex.clone(), text: "before restart".into() })
        .await
        .unwrap();
    match next_event(&mut b_rx, "message").await {
        NodeEvent::Message { body, .. } => assert_eq!(body, "before restart"),
        other => panic!("expected message, got {other:?}"),
    }

    // --- A stops (clean shutdown releases ports + DB) and comes back ---
    a.cmd_tx.send(Command::Shutdown).await.unwrap();
    // The event receiver for the old task closes; give the task a beat to
    // drop the swarm before the new node rebinds.
    tokio::time::sleep(Duration::from_secs(1)).await;

    let (a2_tx, mut a2_rx) = mpsc::unbounded_channel();
    let a2 = spawn(
        NodeConfig {
            data_dir: a_dir.clone(),
            offline: true,
            auto_approve: true,
            ..Default::default()
        },
        a2_tx,
    )
    .await
    .unwrap();
    assert_eq!(
        a2.peer_id, a.peer_id,
        "same data dir must restore the same identity"
    );

    // B is still connected to the OLD swarm (now dead). Its queued message
    // flushes once we re-dial from A's new listener.
    b.cmd_tx
        .send(Command::SendMessage { room: room_hex.clone(), text: "after restart".into() })
        .await
        .unwrap();
    // Find A's fresh listen address and reconnect B -> A.
    let a2_addr = loop {
        match next_event(&mut a2_rx, "listening").await {
            NodeEvent::Listening { addr } if addr.contains("quic") => break addr,
            _ => continue,
        }
    };
    b.cmd_tx
        .send(Command::Dial {
            addr: format!("{a2_addr}/p2p/{}", a2.peer_id).parse().unwrap(),
        })
        .await
        .unwrap();

    // The proof: A decrypts B's frame with the RESTORED key, in the
    // RESTORED room — without any new invitation round.
    match next_event(&mut a2_rx, "message").await {
        NodeEvent::Message { room, body, sender, .. } => {
            assert_eq!(room, room_hex);
            assert_eq!(body, "after restart");
            assert_eq!(sender, b.peer_id.to_string());
        }
        other => panic!("expected restored-room message, got {other:?}"),
    }

    // And the room continues to work host -> guest as well.
    a2.cmd_tx
        .send(Command::SendMessage { room: room_hex, text: "host back".into() })
        .await
        .unwrap();
    match next_event(&mut b_rx, "message").await {
        NodeEvent::Message { body, .. } => assert_eq!(body, "host back"),
        other => panic!("expected reply, got {other:?}"),
    }
}
