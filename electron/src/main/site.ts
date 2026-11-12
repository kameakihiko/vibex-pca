// The values of one team's own servers: the "site". The repository holds made-up values only, which the tests and a
// dev run use. A release build takes the real ones from site.local.json (never committed; build.mjs reads it, and
// site.example.json shows its shape), so no address of a real server is in the source. No Electron here.

export interface Site {
  /// The team server: its address, and the login that all people share (each with their own key).
  host: string;
  user: string;
  /// The server's ed25519 host key, as `ssh-ed25519 <base64>`, and its SHA256 fingerprint. The app pins them (pcaHostKey.ts).
  hostKey: string;
  hostKeyFingerprint: string;
  /// Where a person sends a file that is too large for the chat. Shown as text only.
  uploadPage: string;
}

/// Made up. 203.0.113.0/24 is kept for documents (RFC 5737), and the key pair was made for this file and thrown away.
export const EXAMPLE_SITE: Site = {
  host: '203.0.113.20',
  user: 'pca',
  hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHskZSbJ74lpVMds6VWUzrOBw+bq078/gUcLSYkScbNU',
  hostKeyFingerprint: 'SHA256:nWlCa0k8AYz2R0+dYNoYQlcJ7hkEcYeBBI2Cggjez0w',
  uploadPage: 'files.example.invalid/upload',
};

declare const VIBEX_SITE: Site;
export const SITE: Site = typeof VIBEX_SITE === 'undefined' ? EXAMPLE_SITE : VIBEX_SITE;
