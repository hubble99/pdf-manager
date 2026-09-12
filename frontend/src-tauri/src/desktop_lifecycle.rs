//! Bounded loopback-only lifecycle requests. No proxy, shell, or curl config.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

pub(crate) fn post(path: &str, token: Option<&str>, timeout: Duration) -> io::Result<()> {
    post_to(8000, path, token, timeout)
}

fn post_to(port: u16, path: &str, token: Option<&str>, timeout: Duration) -> io::Result<()> {
    if !matches!(
        path,
        "/api/v1/edit-content/shutdown" | "/api/v1/settings/clear-temp"
    ) || token
        .is_some_and(|value| value.len() != 32 || !value.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid lifecycle request",
        ));
    }
    let started = Instant::now();
    let remaining = || {
        timeout
            .checked_sub(started.elapsed())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "lifecycle request timed out"))
    };
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, remaining()?)?;
    stream.set_write_timeout(Some(remaining()?))?;
    let authorization = token
        .map(|value| format!("X-PDF-Manager-Lifecycle: {value}\r\n"))
        .unwrap_or_default();
    stream.write_all(format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{authorization}Content-Length: 0\r\nConnection: close\r\n\r\n"
    ).as_bytes())?;
    let mut status = Vec::new();
    // Only the bounded status line is needed; do not follow redirects or read
    // an arbitrarily large response while the desktop is exiting.
    while status.len() < 128 {
        stream.set_read_timeout(Some(remaining()?))?;
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        status.push(byte[0]);
        if byte[0] == b'\n' {
            if status.starts_with(b"HTTP/1.1 200 ") || status.starts_with(b"HTTP/1.0 200 ") {
                return Ok(());
            }
            break;
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "lifecycle request was not accepted",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn sends_token_only_to_loopback_without_command_arguments() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 1024);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("POST /api/v1/edit-content/shutdown HTTP/1.1\r\n"));
            assert!(
                request.contains("X-PDF-Manager-Lifecycle: 0123456789abcdef0123456789abcdef\r\n")
            );
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        post_to(
            port,
            "/api/v1/edit-content/shutdown",
            Some("0123456789abcdef0123456789abcdef"),
            Duration::from_secs(2),
        )
        .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn rejects_header_injection_and_unexpected_endpoints_before_connecting() {
        assert_eq!(
            post(
                "/api/v1/edit-content/shutdown",
                Some("secret\r\nInjected: yes"),
                Duration::from_secs(1)
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            post("http://example.com", None, Duration::from_secs(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn stalled_backend_is_bounded() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(400));
        });
        let started = Instant::now();
        assert!(post_to(
            port,
            "/api/v1/settings/clear-temp",
            None,
            Duration::from_millis(100)
        )
        .is_err());
        assert!(started.elapsed() < Duration::from_millis(350));
        server.join().unwrap();
    }

    #[test]
    fn failed_shutdown_is_not_reported_as_success() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\n\r\n")
                .unwrap();
        });
        assert!(post_to(
            port,
            "/api/v1/settings/clear-temp",
            None,
            Duration::from_secs(1)
        )
        .is_err());
        server.join().unwrap();
    }
}
