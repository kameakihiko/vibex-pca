// The part of vibex-askpass that reads what others wrote: the environment, the prompt and the reply. No Windows and no C library
// here, so core-test.c can run it with sanitizers on Linux. Every length is checked; a value that does not fit is a refusal.
#ifndef VIBEX_ASKPASS_CORE_H
#define VIBEX_ASKPASS_CORE_H

#include <stddef.h>
#include <stdint.h>

enum {
    AP_MAX_KEY = 128,
    AP_MAX_HINT = 32,
    AP_MAX_PROMPT = 4096,
    // MAX_BODY of askpass.ts, with the line end of the frame.
    AP_MAX_BODY = 16384,
    // ssh reads 1023 bytes (readpass.c, buf[1024]) and cuts the rest. A cut password must not reach a server.
    AP_MAX_ANSWER = 1022,
    // "OK\n", the answer, "\n", and one byte more so that a longer reply is seen as longer.
    AP_MAX_REPLY = AP_MAX_ANSWER + 5,
    AP_MAX_PIPE = 256
};

enum { AP_MORE = 0, AP_OK = 1, AP_REFUSED = 2 };

static size_t ap_length(const char *text) {
    size_t n = 0;
    while (text[n]) n++;
    return n;
}

/// A ticket is hex (askpass.ts: randomBytes(32).toString('hex')), so it needs no escape and cannot end a JSON string.
static int ap_key_ok(const char *key) {
    size_t n = ap_length(key);
    if (n == 0 || n > AP_MAX_KEY) return 0;
    for (size_t i = 0; i < n; i++) {
        char c = key[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
    }
    return 1;
}

/// Only a pipe of this computer: `\\host\pipe\x` would send this login's NTLM hash to that host.
static int ap_pipe_ok(const char *name) {
    static const char head[] = "\\\\.\\pipe\\";
    size_t n = ap_length(name), h = sizeof head - 1;
    if (n <= h || n >= AP_MAX_PIPE) return 0;
    for (size_t i = 0; i < h; i++) {
        if (name[i] != head[i]) return 0;
    }
    for (size_t i = h; i < n; i++) {
        char c = name[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-' || c == '_')) return 0;
    }
    return 1;
}

/// The value of a variable that holds printable ASCII only, or a refusal.
static int ap_ascii_from_utf16(const uint16_t *wide, size_t units, char *out, size_t cap) {
    if (units >= cap) return 0;
    for (size_t i = 0; i < units; i++) {
        if (wide[i] < 0x20 || wide[i] > 0x7e) return 0;
        out[i] = (char)wide[i];
    }
    out[units] = 0;
    return 1;
}

static int ap_append(char *out, size_t cap, size_t *len, const char *text, size_t n) {
    if (n >= cap || *len >= cap - n) return 0;
    for (size_t i = 0; i < n; i++) out[*len + i] = text[i];
    *len += n;
    return 1;
}

/// A JSON string's body: ", \ and control characters escaped. Other bytes stay, because they are UTF-8 already.
static int ap_escape(char *out, size_t cap, size_t *len, const char *text) {
    static const char digits[] = "0123456789abcdef";
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        char buf[6];
        size_t n;
        if (*p == '"' || *p == '\\') {
            buf[0] = '\\';
            buf[1] = (char)*p;
            n = 2;
        } else if (*p < 0x20 || *p == 0x7f) {
            buf[0] = '\\';
            buf[1] = 'u';
            buf[2] = '0';
            buf[3] = '0';
            buf[4] = digits[*p >> 4];
            buf[5] = digits[*p & 15];
            n = 6;
        } else {
            buf[0] = (char)*p;
            n = 1;
        }
        if (!ap_append(out, cap, len, buf, n)) return 0;
    }
    return 1;
}

/// The framed line of askpassHelper.ts: one JSON object and a line end. 0 when it would not fit in the app's limit.
static int ap_build_request(char *out, size_t cap, size_t *len, const char *key, const char *hint, const char *prompt) {
    *len = 0;
    if (cap > AP_MAX_BODY) cap = AP_MAX_BODY;
    return ap_append(out, cap, len, "{\"key\":\"", 8) && ap_escape(out, cap, len, key)
        && ap_append(out, cap, len, "\",\"hint\":\"", 10) && ap_escape(out, cap, len, hint)
        && ap_append(out, cap, len, "\",\"prompt\":\"", 12) && ap_escape(out, cap, len, prompt)
        && ap_append(out, cap, len, "\"}\n", 3);
}

/// A reply is "OK\n", the answer and "\n", and nothing after it. AP_MORE: no end yet. Anything else, also "NO\n", is a refusal,
/// and a refusal never says how far the bytes were right.
static int ap_reply_parse(const char *reply, size_t len, size_t *start, size_t *answer) {
    static const char head[] = "OK\n";
    for (size_t i = 0; i < 3 && i < len; i++) {
        if (reply[i] != head[i]) return AP_REFUSED;
    }
    if (len < 3) return AP_MORE;
    for (size_t i = 3; i < len; i++) {
        if (i - 3 > AP_MAX_ANSWER) return AP_REFUSED;
        if (reply[i] == '\r' || reply[i] == 0) return AP_REFUSED;
        if (reply[i] != '\n') continue;
        if (i == 3 || i + 1 != len) return AP_REFUSED;
        *start = 3;
        *answer = i - 3;
        return AP_OK;
    }
    return len - 3 > AP_MAX_ANSWER ? AP_REFUSED : AP_MORE;
}

/// Through a volatile pointer, so the compiler keeps it although the buffer is not read again.
static void ap_wipe(void *buffer, size_t n) {
    volatile unsigned char *p = (volatile unsigned char *)buffer;
    while (n--) *p++ = 0;
}

#endif
