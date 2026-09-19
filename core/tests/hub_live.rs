//! Live-hub room election + join: A founds THE room (registers the host
//! record on the production Vercel hub); B discovers the record, dials A
//! via the hub, joins on GK proof, and the two chat. No Dial commands.
//! Requires network and mutates the real hub (records are TTL-scoped), so
//! it is ignored in the default suite:
//!
//! cargo test -p onlyhumans_core --test hub_live -- --ignored --nocapture

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
            NodeEvent::JoinStatus { .. } => "join_status",
            NodeEvent::RoomReady { .. } => "room_ready",
            NodeEvent::Message { .. } => "message",
            NodeEvent::MembersChanged { .. } => "members",
            NodeEvent::MessagesCleared { .. } => "messages_cleared",
            NodeEvent::Rotated { .. } => "rotated",
            NodeEvent::ConnectionStateChanged { .. } => "conn",
            NodeEvent::Log { .. } => "log",
            NodeEvent::Presence { .. } => "presence",
        };
        eprintln!("  [{want}] got {kind}: {ev:?}");
        if kind == want {
            return ev;
        }
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("oh-hubroom-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

async fn wait_members(rx: &mut mpsc::UnboundedReceiver<NodeEvent>, expect: &[String]) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        assert!(tokio::time::Instant::now() < deadline, "members never settled");
        let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out waiting for members")
            .expect("node task died");
        if let NodeEvent::MembersChanged { members, .. } = &ev {
            let mut got: Vec<String> = members.iter().map(|m| m.peer.clone()).collect();
            let mut want = expect.to_vec();
            got.sort();
            want.sort();
            if got == want {
                return;
            }
        }
    }
}

#[tokio::test]
#[ignore = "touches the production hub (network)"]
async fn room_election_and_join_through_live_hub() {
    // A: online founding host (skips the empty-record grace period).
    let (a_tx, mut a_rx) = mpsc::unbounded_channel();
    let a = spawn(
        NodeConfig {
            data_dir: temp_dir("a"),
            assume_host: true,
            username: Some("alice".into()),
            ..Default::default()
        },
        a_tx,
    )
    .await
    .unwrap();

    let a_room = match next_event(&mut a_rx, "room_ready").await {
        NodeEvent::RoomReady { room, we_are_host: true, .. } => room,
        other => panic!("A should found the room, got {other:?}"),
    };
    eprintln!("  room = {a_room}");

    // B: online joiner — discovers the host record and dials via the hub.
    let (b_tx, mut b_rx) = mpsc::unbounded_channel();
    let b = spawn(
        NodeConfig {
            data_dir: temp_dir("b"),
            username: Some("bob".into()),
            ..Default::default()
        },
        b_tx,
    )
    .await
    .unwrap();

    match next_event(&mut b_rx, "room_ready").await {
        NodeEvent::RoomReady { room, we_are_host: false, .. } => {
            assert_eq!(room, a_room, "B must land in the same global room");
        }
        other => panic!("B should join via the hub record, got {other:?}"),
    }

    let both = vec![a.peer_id.to_string(), b.peer_id.to_string()];
    wait_members(&mut a_rx, &both).await;
    wait_members(&mut b_rx, &both).await;

    a.cmd_tx.send(Command::SendMessage { room: a_room.clone(), text: "from founder".into() }).await.unwrap();
    match next_event(&mut b_rx, "message").await {
        NodeEvent::Message { body, sender, .. } => {
            assert_eq!(body, "from founder");
            assert_eq!(sender, a.peer_id.to_string());
        }
        other => panic!("expected message, got {other:?}"),
    }
    b.cmd_tx.send(Command::SendMessage { room: a_room, text: "from joiner".into() }).await.unwrap();
    match next_event(&mut a_rx, "message").await {
        NodeEvent::Message { body, sender, .. } => {
            assert_eq!(body, "from joiner");
            assert_eq!(sender, b.peer_id.to_string());
        }
        other => panic!("expected message, got {other:?}"),
    }
}
