"""Run the real PowerShell client against a local, non-billing fake gateway."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "aiwork-seedance" / "scripts" / "aiwork-seedance.ps1"
MP4 = b"\x00\x00\x00\x18ftypmp42fixture"
TEST_TEMP_ROOT = os.environ.get("AIWORK_TEST_TMPDIR")


class Gateway(BaseHTTPRequestHandler):
    requests = []
    malicious_url = ""
    redirect_content = False

    def do_GET(self):
        self.requests.append((self.path, self.headers.get("Authorization")))
        if self.path == "/health":
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        elif self.path == "/v1/models":
            body = b'{"error":{"message":"invalid key"}}'
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
        elif self.path == "/v1/videos/video-test":
            body = json.dumps({"task": {"id": "video-test", "status": "completed", "content_url": self.malicious_url}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        elif self.path == "/v1/videos/video-test/content":
            if self.redirect_content:
                self.send_response(302)
                self.send_header("Location", self.malicious_url)
                self.end_headers()
                return
            body = MP4
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
        else:
            body = b"not found"
            self.send_response(404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class Attacker(Gateway):
    requests = []

    def do_GET(self):
        self.requests.append((self.path, self.headers.get("Authorization")))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(MP4)


class DownloadTest(unittest.TestCase):
    def test_download_uses_gateway_content_route_not_untrusted_content_url(self):
        Gateway.requests = []
        Gateway.redirect_content = False
        Attacker.requests = []
        gateway = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        attacker = ThreadingHTTPServer(("127.0.0.1", 0), Attacker)
        Gateway.malicious_url = f"http://127.0.0.1:{attacker.server_port}/steal"
        for server in (gateway, attacker):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as directory:
                output = Path(directory) / "video.mp4"
                env = dict(os.environ, TEMP=directory, TMP=directory)
                result = subprocess.run(
                    ["pwsh", "-NoProfile", "-File", str(SCRIPT), "-Action", "download", "-TaskId", "video-test",
                     "-GatewayBaseUrl", f"http://127.0.0.1:{gateway.server_port}/v1", "-ApiKey", "fake-user-key",
                     "-OutputPath", str(output)],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, env=env,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output.read_bytes(), MP4)
            self.assertEqual(Attacker.requests, [])
            self.assertEqual(Gateway.requests, [
                ("/v1/videos/video-test", "Bearer fake-user-key"),
                ("/v1/videos/video-test/content", "Bearer fake-user-key"),
            ])
        finally:
            gateway.shutdown()
            attacker.shutdown()
            gateway.server_close()
            attacker.server_close()

    def test_download_refuses_cross_origin_redirect_with_bearer_key(self):
        Gateway.requests = []
        Attacker.requests = []
        gateway = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        attacker = ThreadingHTTPServer(("127.0.0.1", 0), Attacker)
        Gateway.malicious_url = f"http://127.0.0.1:{attacker.server_port}/steal"
        Gateway.redirect_content = True
        for server in (gateway, attacker):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as directory:
                output = Path(directory) / "video.mp4"
                result = subprocess.run(
                    ["pwsh", "-NoProfile", "-File", str(SCRIPT), "-Action", "download", "-TaskId", "video-test",
                     "-GatewayBaseUrl", f"http://127.0.0.1:{gateway.server_port}/v1", "-ApiKey", "fake-user-key",
                     "-OutputPath", str(output)],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
                    env=dict(os.environ, TEMP=directory, TMP=directory),
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())
            self.assertEqual(Attacker.requests, [])
        finally:
            Gateway.redirect_content = False
            gateway.shutdown()
            attacker.shutdown()
            gateway.server_close()
            attacker.server_close()

    def test_doctor_rejects_invalid_key_even_when_health_is_ok(self):
        Gateway.requests = []
        gateway = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=gateway.serve_forever, daemon=True).start()
        try:
            result = subprocess.run(
                ["pwsh", "-NoProfile", "-File", str(SCRIPT), "-Action", "doctor",
                 "-GatewayBaseUrl", f"http://127.0.0.1:{gateway.server_port}/v1", "-ApiKey", "invalid-key"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(("/v1/models", "Bearer invalid-key"), Gateway.requests)
        finally:
            gateway.shutdown()
            gateway.server_close()


if __name__ == "__main__":
    unittest.main()
