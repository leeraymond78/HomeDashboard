#!/usr/bin/env python3
"""Local dev server. Use --https for phone geolocation (iOS requires secure context)."""
import http.server
import os
import socketserver
import ssl
import subprocess
import sys

PORT = 8765
CERT = 'dev-cert.pem'
KEY = 'dev-key.pem'


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.split('?', 1)[0]
        if path.endswith(('.js', '.html', '.css', '.json')):
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            self.send_header('Pragma', 'no-cache')
        super().end_headers()


def ensure_cert():
    if os.path.exists(CERT) and os.path.exists(KEY):
        return
    subprocess.run([
        'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', KEY, '-out', CERT, '-days', '365',
        '-subj', '/CN=localhost',
    ], check=True)


def local_ip():
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80))
            return s.getsockname()[0]
    except OSError:
        return None


if __name__ == '__main__':
    use_https = '--https' in sys.argv
    with socketserver.TCPServer(('', PORT), Handler) as httpd:
        if use_https:
            ensure_cert()
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(CERT, KEY)
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
            ip = local_ip()
            print(f'https://127.0.0.1:{PORT}/')
            if ip:
                print(f'https://{ip}:{PORT}/  (use this on iPhone)')
        else:
            print(f'http://127.0.0.1:{PORT}/')
            print('Phone geolocation needs: python3 serve.py --https')
        httpd.serve_forever()
