use std::time::Duration;
use tokio::process::Command;
use xcb_runtime::process::capture;

#[tokio::test]
async fn finite_output_is_collected_and_oversized_output_is_refused() {
    let mut command = Command::new("/bin/echo");
    command.arg("hello").env_clear();
    assert_eq!(
        capture(command, 128, Duration::from_secs(2)).await.unwrap(),
        b"hello\n"
    );
    let mut command = Command::new("/bin/echo");
    command.arg("larger than the output allowance").env_clear();
    assert!(capture(command, 4, Duration::from_secs(2)).await.is_err());
}

#[tokio::test]
async fn a_stalled_owned_process_is_terminated_at_its_deadline() {
    let mut command = Command::new("/bin/sleep");
    command.arg("10").env_clear();
    assert!(
        capture(command, 128, Duration::from_millis(20))
            .await
            .is_err()
    );
}
