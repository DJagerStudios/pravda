# Hosting a Pravda server

A Pravda server is one program with no other dependencies. It keeps
everything in one data directory: a SQLite database, uploaded files (all of
them encrypted by the clients) and its own secrets.

There are three common setups:

1. **From the desktop app**: *Start hosting* on the server picker runs a
   server on your computer for friends on the same network.
2. **On a home network**: run the server with a self-signed certificate.
3. **On the internet**: run it with a domain name and an automatic
   Let's Encrypt certificate, or behind your own reverse proxy.

## Ports

| Port | Protocol | Purpose |
| --- | --- | --- |
| 8347 (or 443 with `--domain`) | TCP | The web client, the API and the realtime gateway |
| 8348 | UDP | Voice and video |
| 8348 | TCP | Voice and video for networks that block UDP (`--media-tcp 0` turns it off) |

Open them in your firewall. With ufw, for example:

```sh
sudo ufw allow 8347/tcp
sudo ufw allow 8348/udp
sudo ufw allow 8348/tcp
```

## On a home network

```sh
./pravda --tls-self-signed --listen 0.0.0.0:8347
```

The server makes a certificate for this computer's names and addresses and
prints its SHA-256 fingerprint. Friends open `https://<your address>:8347`:

- **Browsers** show a warning page for the self-signed certificate. After
  they accept it, everything works, including microphones and cameras, which
  browsers only allow over HTTPS.
- **The desktop app** shows the fingerprint and asks whether to trust it. Read
  yours out to them so they can check it matches. The app then remembers
  exactly that certificate.

Plain HTTP (no `--tls-self-signed`) is fine on `localhost` only: browsers
refuse microphones and cameras over HTTP from other machines.

## On the internet

### With a domain name (simplest)

Point a DNS record at your server, then run:

```sh
sudo ./pravda --domain chat.example.org
```

Pravda gets and renews a Let's Encrypt certificate itself, serving HTTPS on
port 443 and the certificate challenge on port 80. Running on those ports
needs root or `CAP_NET_BIND_SERVICE`. A dedicated user with that capability
is better than root:

```sh
sudo setcap cap_net_bind_service=+ep ./pravda
```

### Behind a reverse proxy

If you already run Caddy, nginx or similar, let Pravda listen locally and
pass it the public URL:

```sh
./pravda --listen 127.0.0.1:8347 --public-url https://chat.example.org --trust-proxy
```

The proxy must forward WebSocket upgrades for `/gateway` and keep connections
open for a long time. A Caddy example:

```
chat.example.org {
    reverse_proxy 127.0.0.1:8347
}
```

Voice and video do not go through the proxy. They need UDP 8348 (and
optionally TCP 8348) reachable directly on the server's public address.

### Behind NAT or in the cloud

If the server's own network address is not its public one (a home router, a
cloud VM with a private address), tell Pravda which address to advertise for
media:

```sh
./pravda --domain chat.example.org --public-ip 203.0.113.7
```

Forward UDP 8348 and TCP 8348 on your router to the server.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--listen` | `127.0.0.1:8347` | Address for HTTP and the gateway |
| `--data` | `~/.local/share/pravda` | Data directory |
| `--name` | `Pravda` | Instance name on the sign-in page |
| `--registration` | `invite` | Who may create accounts: `open`, `invite` (only through an invite link) or `closed`. The first account can always be created. |
| `--require-2fa` | `true` | Every account must set up an authenticator app |
| `--max-upload-mb` | `100` | Largest file upload |
| `--domain` | | Get a Let's Encrypt certificate for this domain; serve on 443 and 80 |
| `--tls-self-signed` | `false` | Generate and use a self-signed certificate |
| `--tls-cert`, `--tls-key` | | Use your own certificate files |
| `--public-url` | | The external URL when behind a reverse proxy |
| `--trust-proxy` | `false` | Believe `X-Forwarded-For` (only behind your own proxy) |
| `--media-udp` | `8348` | UDP port for voice and video |
| `--media-tcp` | `8348` | TCP fallback port for media; `0` disables it |
| `--public-ip` | | Comma-separated addresses to advertise for media |
| `--debug` | `false` | Verbose logging |
| `--version` | | Print the version and exit |

## Running it as a service

A systemd unit, assuming a `pravda` user and the binary in `/usr/local/bin`:

```ini
[Unit]
Description=Pravda
After=network-online.target
Wants=network-online.target

[Service]
User=pravda
ExecStart=/usr/local/bin/pravda --domain chat.example.org --data /var/lib/pravda
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/pravda
PrivateTmp=true
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Backups

Back up the whole data directory while the server is stopped, or use
`sqlite3 pravda.db ".backup backup.db"` while it runs and copy the rest. Keep
`instance.key` with the database: it seals the server's own secrets
(authenticator seeds and server passwords), and the database is useless
without it. Treat backups as sensitive. Messages and files in them are
encrypted, but accounts, memberships and profiles are not.

## Upgrading

Stop the server, replace the binary, start it again. The database is
migrated automatically on start. Clients in browsers pick up the new web
client on their next reload; desktop apps carry their own client and should
be updated separately.
