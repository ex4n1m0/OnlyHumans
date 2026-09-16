//! Live-hub discovery: B registers on the production Vercel hub; A holds no
//! address for B and must find it via /api/lookup alone — no Command::Dial
//! anywhere. Requires network and mutates the real hub (records are
//! TTL-scoped), so it is ignored in the default suite:
//!
//! cargo test -p onlyhumans_core --test hub_live -- --ignored --nocapture

use onlyhumans_core::hub::{HubClient, DEFAULT_HUB};
use onlyhumans_core::net::{spawn, Command, NodeConfig, NodeEvent};
use std::time::Duration;
use tokio::sync::mpsc;

async fn next_event(rx: &mut mpsc::UnboundedReceiver<NodeEvent>, want: &str) -> NodeEvent {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
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
    let d = std::env::temp_dir().join(format!("oh-hublive-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// Wait until the hub serves a verified record for `peer`.
async fn wait_registered(hub: &HubClient, peer: &str) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        match hub.lookup(peer).await {
            Ok(Some(reg)) => {
                assert!(!reg.addrs.is_empty(), "hub record carries no addresses");
                return reg.addrs;
            }
            Ok(None) => {}
            Err(e) => eprintln!("  lookup error (retrying): {e}"),
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "peer never appeared on the hub"
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
#[ignore = "touches the production hub (network)"]
async fn two_nodes_discover_and_chat_through_live_hub() {
    // Both nodes online (default hub = production). A hosts and
    // auto-admits; B consents explicitly, as the UI would.
    let (b_tx, mut b_rx) = mpsc::unbounded_channel();
    let b = spawn(
        NodeConfig {
            data_dir: temp_dir("b"),
            ..Default::default()
        },
        b_tx,
    )
    .await
    .unwrap();

    let (a_tx, mut a_rx) = mpsc::unbounded_channel();
    let a = spawn(
        NodeConfig {
            data_dir: temp_dir("a"),
            auto_approve: true,
            ..Default::default()
        },
        a_tx,
    )
    .await
    .unwrap();

    // Precondition: B's registration must be live on the hub.
    let hub = HubClient::new(DEFAULT_HUB);
    let b_addrs = wait_registered(&hub, &b.peer_id.to_string()).await;
    eprintln!("  hub says {b_addrs:?}");

    // The whole point: no Dial command — OpenConversation must resolve B
    // through the hub and connect from that alone.
    a.cmd_tx
        .send(Command::OpenConversation { peer: b.peer_id.to_string() })
        .await
        .unwrap();

    let invite = next_event(&mut b_rx, "invitation").await;
    let (room, host) = match invite {
        NodeEvent::InvitationReceived { room, host } => (room, host),
        other => panic!("expected invitation, got {other:?}"),
    };
    b.cmd_tx
        .send(Command::AcceptInvitation { room: room.clone(), host })
        .await
        .unwrap();

    let a_ready = next_event(&mut a_rx, "room_ready").await;
    let room = match a_ready {
        NodeEvent::RoomReady { room, we_are_host: true, .. } => room,
        other => panic!("A should be host, got {other:?}"),
    };
    match next_event(&mut b_rx, "room_ready").await {
        NodeEvent::RoomReady { room: r, we_are_host: false, .. } if r == room => {}
        other => panic!("B should be guest in the same room, got {other:?}"),
    }

    a.cmd_tx
        .send(Command::SendMessage { room: room.clone(), text: "via hub".into() })
        .await
        .unwrap();
    match next_event(&mut b_rx, "message").await {
        NodeEvent::Message { body, sender, epoch, .. } => {
            assert_eq!(body, "via hub");
            assert_eq!(sender, a.peer_id.to_string());
            assert_eq!(epoch, 1);
        }
        other => panic!("expected message, got {other:?}"),
    }

    b.cmd_tx
        .send(Command::SendMessage { room: room.clone(), text: "hub ok".into() })
        .await
        .unwrap();
    match next_event(&mut a_rx, "message").await {
        NodeEvent::Message { body, sender, .. } => {
            assert_eq!(body, "hub ok");
            assert_eq!(sender, b.peer_id.to_string());
        }
        other => panic!("expected message, got {other:?}"),
    }

    a.cmd_tx.send(Command::Rotate { room: room.clone() }).await.unwrap();
    match next_event(&mut b_rx, "rotated").await {
        NodeEvent::Rotated { new_epoch, .. } => assert_eq!(new_epoch, 2),
        other => panic!("expected rotation, got {other:?}"),
    }

    a.cmd_tx
        .send(Command::SendMessage { room, text: "epoch2".into() })
        .await
        .unwrap();
    match next_event(&mut b_rx, "message").await {
        NodeEvent::Message { body, epoch, .. } => {
            assert_eq!(body, "epoch2");
            assert_eq!(epoch, 2);
        }
        other => panic!("expected post-rotation message, got {other:?}"),
    }
}
