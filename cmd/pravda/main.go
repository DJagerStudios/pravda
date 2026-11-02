// Command pravda runs a self-hosted Pravda instance: chat, voice, video and
// screen sharing from one binary.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"pravda/internal/server"
	"pravda/internal/sfu"
	"pravda/internal/store"
	"pravda/web"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "pravda:", err)
		os.Exit(1)
	}
}

func run() error {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	var (
		listen       = flag.String("listen", "127.0.0.1:8347", "address for HTTP and the realtime gateway")
		dataDir      = flag.String("data", filepath.Join(home, ".local", "share", "pravda"), "directory for the database and uploads")
		name         = flag.String("name", "Pravda", "instance name shown on the sign-in page")
		registration = flag.String("registration", server.RegistrationInvite, "who may create accounts: open, invite or closed")
		require2FA   = flag.Bool("require-2fa", true, "every account must set up an authenticator app")
		maxUpload    = flag.Int64("max-upload-mb", 100, "largest allowed file upload, in MiB")
		publicURL    = flag.String("public-url", "", "external URL, when behind a reverse proxy")
		trustProxy   = flag.Bool("trust-proxy", false, "believe X-Forwarded-For (only behind your own proxy)")
		mediaUDP     = flag.Int("media-udp", 8348, "UDP port carrying voice and video")
		mediaTCP     = flag.Int("media-tcp", 8348, "TCP fallback port for networks blocking UDP; 0 disables")
		publicIP     = flag.String("public-ip", "", "comma-separated addresses to advertise for media, when behind NAT")
		tlsCert      = flag.String("tls-cert", "", "TLS certificate file")
		tlsKey       = flag.String("tls-key", "", "TLS private key file")
		selfSigned   = flag.Bool("tls-self-signed", false, "generate and use a self-signed certificate, for LAN use")
		domain       = flag.String("domain", "", "obtain a Let's Encrypt certificate for this domain; serves on :443 and :80")
		debug        = flag.Bool("debug", false, "verbose logging")
		version      = flag.Bool("version", false, "print the version and exit")
	)
	flag.Parse()
	if *version {
		fmt.Println("Pravda", server.Version)
		return nil
	}
	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))

	switch *registration {
	case server.RegistrationOpen, server.RegistrationInvite, server.RegistrationClosed:
	default:
		return fmt.Errorf("unknown registration mode %q", *registration)
	}

	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		return err
	}
	db, err := store.Open(filepath.Join(*dataDir, "pravda.db"))
	if err != nil {
		return err
	}
	defer db.Close()

	media := sfu.Config{UDPPort: *mediaUDP, TCPPort: *mediaTCP, Loopback: true}
	if *publicIP != "" {
		media.PublicIPs = strings.Split(*publicIP, ",")
	}
	srv, err := server.New(server.Config{
		Name:           *name,
		DataDir:        *dataDir,
		Registration:   *registration,
		Require2FA:     *require2FA,
		MaxUploadBytes: *maxUpload << 20,
		PublicURL:      *publicURL,
		TrustProxy:     *trustProxy,
		Media:          media,
	}, db, clientFiles())
	if err != nil {
		return err
	}
	defer srv.Close()

	httpServer := &http.Server{
		Addr:              *listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	errs := make(chan error, 2)

	switch {
	case *domain != "":
		manager := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(*domain),
			Cache:      autocert.DirCache(filepath.Join(*dataDir, "certificates")),
		}
		httpServer.Addr = ":443"
		httpServer.TLSConfig = manager.TLSConfig()
		go func() { errs <- http.ListenAndServe(":80", manager.HTTPHandler(nil)) }()
		go func() { errs <- httpServer.ListenAndServeTLS("", "") }()
		slog.Info("Pravda is serving", "url", "https://"+*domain, "media_udp", *mediaUDP)
	case *selfSigned:
		cert, fingerprint, err := selfSignedCertificate(*dataDir)
		if err != nil {
			return err
		}
		httpServer.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		go func() { errs <- httpServer.ListenAndServeTLS("", "") }()
		slog.Info("Pravda is serving with a self-signed certificate", "url", "https://"+*listen, "sha256", fingerprint, "media_udp", *mediaUDP)
	case *tlsCert != "":
		go func() { errs <- httpServer.ListenAndServeTLS(*tlsCert, *tlsKey) }()
		slog.Info("Pravda is serving", "url", "https://"+*listen, "media_udp", *mediaUDP)
	default:
		go func() { errs <- httpServer.ListenAndServe() }()
		slog.Info("Pravda is serving", "url", "http://"+*listen, "media_udp", *mediaUDP)
		if !isLoopback(*listen) {
			slog.Warn("browsers only allow microphones and cameras over HTTPS or localhost; add --tls-self-signed or --domain for remote users")
		}
	}

	select {
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		slog.Info("shutting down")
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdown)
}

// clientFiles serves the embedded client, or a directory named by
// PRAVDA_WEB_DIR while developing.
func clientFiles() fs.FS {
	if dir := os.Getenv("PRAVDA_WEB_DIR"); dir != "" {
		return os.DirFS(dir)
	}
	return web.Files()
}

func isLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// selfSignedCertificate loads or creates a certificate covering this
// machine's addresses. It exists for LAN parties: browsers demand a secure
// context before they will open a microphone, and a warning page is a small
// price for that on a private network.
func selfSignedCertificate(dataDir string) (tls.Certificate, string, error) {
	certPath := filepath.Join(dataDir, "selfsigned.crt")
	keyPath := filepath.Join(dataDir, "selfsigned.key")
	if cert, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		if leaf, err := x509.ParseCertificate(cert.Certificate[0]); err == nil && time.Now().Before(leaf.NotAfter.Add(-24*time.Hour)) {
			return cert, fingerprint(cert), nil
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, "", err
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Pravda"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
	}
	if hostname, err := os.Hostname(); err == nil {
		template.DNSNames = append(template.DNSNames, hostname, hostname+".local")
	}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipNet, ok := a.(*net.IPNet); ok {
				template.IPAddresses = append(template.IPAddresses, ipNet.IP)
			}
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		return tls.Certificate{}, "", err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return tls.Certificate{}, "", err
	}
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	return cert, fingerprint(cert), nil
}

func fingerprint(cert tls.Certificate) string {
	sum := sha256.Sum256(cert.Certificate[0])
	return hex.EncodeToString(sum[:])
}
