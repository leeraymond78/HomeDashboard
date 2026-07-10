# HomeDashboard

**Live demo:** https://leeraymond78.github.io/HomeDashboard/

Hong Kong bus and MTR arrival times dashboard. A lightweight PWA that groups routes by location and refreshes ETA data automatically.

## Setup

Edit `config.json` to define route groups and stops (KMB, NWFB/CTB, MTR Bus, and GMB).

## Run locally

For local development, use the included dev server (`serve.py`). It serves static files from the project root on port **8765** and sends no-cache headers for `.js`, `.html`, `.css`, and `.json` so you always see the latest changes.

```bash
python3 serve.py
```

Then open http://127.0.0.1:8765/

This is for **local testing only** — not production deployment.

### Test on your phone (geolocation)

The dashboard can use your device location to sort nearby stops. Browsers only allow geolocation in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (HTTPS, or `localhost`). On iPhone, opening the app over your home Wi‑Fi at `http://192.168.x.x` is **not** secure, so location will not work.

Run with HTTPS instead:

```bash
python3 serve.py --https
```

On first run this creates a self-signed certificate (`dev-cert.pem`, `dev-key.pem`) via OpenSSL. The server prints a LAN URL — open that on your phone (same Wi‑Fi), accept the certificate warning, then allow location when prompted.

### Alternative

Any static file server works for basic local preview, for example:

```bash
python3 -m http.server 8080
```

Geolocation on a phone over the network still requires HTTPS; use `serve.py --https` for that.

## Deploy

This repo deploys with GitHub Actions (`.github/workflows/deploy.yml`).

1. Open **Settings → Pages** on GitHub.
2. Set **Build and deployment → Source** to **GitHub Actions** (not "Deploy from a branch").
3. Push to `main`. On the first run, approve the `github-pages` environment if prompted.

Static files are served from the repository root. The included `.nojekyll` file disables Jekyll processing.

## Acknowledgements

This app uses bus route, fare, and stop data from **HK Bus Crawling@2021**: https://github.com/hkbus/hk-bus-crawling
