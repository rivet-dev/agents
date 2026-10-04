use super::*;
use futures::{SinkExt, StreamExt};
use serial_test::serial;
use std::collections::BTreeMap;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

fn png_dimensions(bytes: &[u8]) -> (u32, u32) {
    assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("png width bytes"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("png height bytes"));
    (width, height)
}

async fn recv_ws_message(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Message {
    tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("timed out waiting for websocket frame")
        .expect("websocket stream ended")
        .expect("websocket frame")
}

#[tokio::test]
#[serial]
async fn v1_desktop_status_reports_install_required_when_dependencies_are_missing() {
    let temp = tempfile::tempdir().expect("create empty path tempdir");
    let mut env = BTreeMap::new();
    env.insert(
        "PATH".to_string(),
        temp.path().to_string_lossy().to_string(),
    );

    let test_app = TestApp::with_options(
        AuthConfig::disabled(),
        docker_support::TestAppOptions {
            env,
            replace_path: true,
            ..Default::default()
        },
        |_| {},
    );

    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/desktop/status", None, &[]).await;

    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["state"], "install_required");
    assert!(parsed["missingDependencies"]
        .as_array()
        .expect("missingDependencies array")
        .iter()
        .any(|value| value == "Xvfb"));
    assert_eq!(
        parsed["installCommand"],
        "sandbox-agent install desktop --yes"
    );
}

#[tokio::test]
#[serial]
async fn v1_desktop_lifecycle_and_actions_work_with_real_runtime() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/start",
        Some(json!({
            "width": 1440,
            "height": 900,
            "dpi": 96
        })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected start response: {}",
        String::from_utf8_lossy(&body)
    );
    let parsed = parse_json(&body);
    assert_eq!(parsed["state"], "active");
    let display = parsed["display"]
        .as_str()
        .expect("desktop display")
        .to_string();
    assert!(display.starts_with(':'));
    assert_eq!(parsed["resolution"]["width"], 1440);
    assert_eq!(parsed["resolution"]["height"], 900);

    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/desktop/screenshot",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("image/png")
    );
    assert!(body.starts_with(b"\x89PNG\r\n\x1a\n"));
    assert_eq!(png_dimensions(&body), (1440, 900));

    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/desktop/screenshot?format=jpeg&quality=50",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("image/jpeg")
    );
    assert!(body.starts_with(&[0xff, 0xd8, 0xff]));

    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/desktop/screenshot?scale=0.5",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("image/png")
    );
    assert_eq!(png_dimensions(&body), (720, 450));

    let (status, _, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/desktop/screenshot/region?x=10&y=20&width=30&height=40",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.starts_with(b"\x89PNG\r\n\x1a\n"));

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/desktop/display/info",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let display_info = parse_json(&body);
    assert_eq!(display_info["display"], display);
    assert_eq!(display_info["resolution"]["width"], 1440);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/move",
        Some(json!({ "x": 400, "y": 300 })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mouse = parse_json(&body);
    assert_eq!(mouse["x"], 400);
    assert_eq!(mouse["y"], 300);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/drag",
        Some(json!({
            "startX": 100,
            "startY": 110,
            "endX": 220,
            "endY": 230,
            "button": "left"
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let dragged = parse_json(&body);
    assert_eq!(dragged["x"], 220);
    assert_eq!(dragged["y"], 230);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/click",
        Some(json!({
            "x": 220,
            "y": 230,
            "button": "left",
            "clickCount": 1
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let clicked = parse_json(&body);
    assert_eq!(clicked["x"], 220);
    assert_eq!(clicked["y"], 230);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/down",
        Some(json!({
            "x": 220,
            "y": 230,
            "button": "left"
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mouse_down = parse_json(&body);
    assert_eq!(mouse_down["x"], 220);
    assert_eq!(mouse_down["y"], 230);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/move",
        Some(json!({ "x": 260, "y": 280 })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let moved_while_down = parse_json(&body);
    assert_eq!(moved_while_down["x"], 260);
    assert_eq!(moved_while_down["y"], 280);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/up",
        Some(json!({ "button": "left" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mouse_up = parse_json(&body);
    assert_eq!(mouse_up["x"], 260);
    assert_eq!(mouse_up["y"], 280);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/scroll",
        Some(json!({
            "x": 220,
            "y": 230,
            "deltaY": -3
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let scrolled = parse_json(&body);
    assert_eq!(scrolled["x"], 220);
    assert_eq!(scrolled["y"], 230);

    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/desktop/windows", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(parse_json(&body)["windows"].is_array());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/desktop/mouse/position",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let position = parse_json(&body);
    assert_eq!(position["x"], 220);
    assert_eq!(position["y"], 230);

    launch_desktop_focus_window(&test_app.app, &display).await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/keyboard/type",
        Some(json!({ "text": "hello world", "delayMs": 5 })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["ok"], true);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/keyboard/press",
        Some(json!({ "key": "ctrl+l" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["ok"], true);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/keyboard/press",
        Some(json!({
            "key": "l",
            "modifiers": {
                "ctrl": true
            }
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["ok"], true);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/keyboard/down",
        Some(json!({ "key": "shift" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["ok"], true);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/keyboard/up",
        Some(json!({ "key": "shift" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["ok"], true);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/recording/start",
        Some(json!({ "fps": 8 })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let recording = parse_json(&body);
    let recording_id = recording["id"].as_str().expect("recording id").to_string();
    assert_eq!(recording["status"], "recording");

    tokio::time::sleep(Duration::from_secs(2)).await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/recording/stop",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let stopped_recording = parse_json(&body);
    assert_eq!(stopped_recording["id"], recording_id);
    assert_eq!(stopped_recording["status"], "completed");

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/desktop/recordings",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(parse_json(&body)["recordings"].is_array());

    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        &format!("/v1/desktop/recordings/{recording_id}/download"),
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("video/mp4")
    );
    assert!(body.windows(4).any(|window| window == b"ftyp"));

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/stream/start",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["active"], true);

    let (mut ws, _) = connect_async(test_app.app.ws_url("/v1/desktop/stream/ws"))
        .await
        .expect("connect desktop stream websocket");

    let ready = recv_ws_message(&mut ws).await;
    match ready {
        Message::Text(text) => {
            let value: Value = serde_json::from_str(&text).expect("desktop stream ready frame");
            assert_eq!(value["type"], "ready");
            assert_eq!(value["width"], 1440);
            assert_eq!(value["height"], 900);
        }
        other => panic!("expected text ready frame, got {other:?}"),
    }

    let frame = recv_ws_message(&mut ws).await;
    match frame {
        Message::Binary(bytes) => assert!(bytes.starts_with(&[0xff, 0xd8, 0xff])),
        other => panic!("expected binary jpeg frame, got {other:?}"),
    }

    ws.send(Message::Text(
        json!({
            "type": "moveMouse",
            "x": 320,
            "y": 330
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("send desktop stream mouse move");
    let _ = ws.close(None).await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/stream/stop",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["active"], false);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        &format!("/v1/desktop/recordings/{recording_id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _, body) =
        send_request(&test_app.app, Method::POST, "/v1/desktop/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["state"], "inactive");
}
