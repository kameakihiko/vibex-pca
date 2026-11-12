// The reading part of vibex-askpass under sanitizers, on Linux in CI: cc -fsanitize=address,undefined core-test.c. Fixed cases, then
// random bytes against each reader. Exit code 0 only when every case holds.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "askpass_core.h"

static int failures = 0;
#define CHECK(x) do { if (!(x)) { printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #x); failures++; } } while (0)

static int parse(const char *text, size_t len, size_t *s, size_t *a) {
    // A heap copy of exactly this length, so a read past the end is seen.
    char *copy = malloc(len ? len : 1);
    memcpy(copy, text, len);
    int r = ap_reply_parse(copy, len, s, a);
    free(copy);
    return r;
}

int main(void) {
    size_t s = 0, a = 0, n = 0;
    char out[AP_MAX_BODY];

    CHECK(ap_key_ok("00ff"));
    CHECK(!ap_key_ok(""));
    CHECK(!ap_key_ok("00FF"));
    CHECK(!ap_key_ok("0\"0"));
    char big[AP_MAX_KEY + 2];
    memset(big, 'a', sizeof big - 2);
    big[AP_MAX_KEY] = 0;
    CHECK(ap_key_ok(big));
    big[AP_MAX_KEY] = 'a';
    big[AP_MAX_KEY + 1] = 0;
    CHECK(!ap_key_ok(big));

    CHECK(ap_pipe_ok("\\\\.\\pipe\\vibex-askpass-00ff"));
    CHECK(!ap_pipe_ok("\\\\.\\pipe\\"));
    CHECK(!ap_pipe_ok("\\\\host\\pipe\\x"));
    CHECK(!ap_pipe_ok("\\\\.\\pipe\\a\\..\\b"));
    CHECK(!ap_pipe_ok("\\\\.\\pipe\\a b"));
    CHECK(!ap_pipe_ok("C:\\a"));

    const uint16_t wide[] = {'a', 'b', 0x416};
    char ascii[3];
    CHECK(ap_ascii_from_utf16(wide, 2, ascii, sizeof ascii) && !strcmp(ascii, "ab"));
    CHECK(!ap_ascii_from_utf16(wide, 3, ascii, sizeof ascii));
    CHECK(!ap_ascii_from_utf16(wide, 3, ascii, 8));

    CHECK(ap_build_request(out, sizeof out, &n, "ab", "", "a\"b\\c\n\x7f\xd0\x96"));
    CHECK(n == strlen("{\"key\":\"ab\",\"hint\":\"\",\"prompt\":\"a\\\"b\\\\c\\u000a\\u007f\xd0\x96\"}\n"));
    CHECK(!memcmp(out, "{\"key\":\"ab\",\"hint\":\"\",\"prompt\":\"a\\\"b\\\\c\\u000a\\u007f\xd0\x96\"}\n", n));

    // The worst prompt is six times its size, and must stop inside the buffer, whatever the buffer's size.
    static char worst[AP_MAX_PROMPT + 1];
    memset(worst, 1, AP_MAX_PROMPT);
    CHECK(!ap_build_request(out, sizeof out, &n, "ab", "", worst));
    for (size_t cap = 0; cap < 60; cap++) {
        char *small = malloc(cap ? cap : 1);
        CHECK(!ap_build_request(small, cap, &n, "ab", "h", "a prompt that does not fit"));
        free(small);
    }

    CHECK(parse("", 0, &s, &a) == AP_MORE);
    CHECK(parse("O", 1, &s, &a) == AP_MORE);
    CHECK(parse("OK\n", 3, &s, &a) == AP_MORE);
    CHECK(parse("OK\nabc", 6, &s, &a) == AP_MORE);
    CHECK(parse("OK\nabc\n", 7, &s, &a) == AP_OK && s == 3 && a == 3);
    CHECK(parse("NO\n", 3, &s, &a) == AP_REFUSED);
    CHECK(parse("N", 1, &s, &a) == AP_REFUSED);
    CHECK(parse("OK\n\n", 4, &s, &a) == AP_REFUSED);
    CHECK(parse("OK\na\r\n", 6, &s, &a) == AP_REFUSED);
    CHECK(parse("OK\na\nb\n", 7, &s, &a) == AP_REFUSED);
    CHECK(parse("OK\na\0b\n", 7, &s, &a) == AP_REFUSED);
    static char longest[AP_MAX_REPLY + 8];
    memcpy(longest, "OK\n", 3);
    memset(longest + 3, 'a', AP_MAX_ANSWER);
    longest[3 + AP_MAX_ANSWER] = '\n';
    CHECK(parse(longest, 3 + AP_MAX_ANSWER, &s, &a) == AP_MORE);
    CHECK(parse(longest, 4 + AP_MAX_ANSWER, &s, &a) == AP_OK && a == AP_MAX_ANSWER);
    longest[3 + AP_MAX_ANSWER] = 'a';
    longest[4 + AP_MAX_ANSWER] = '\n';
    CHECK(parse(longest, 5 + AP_MAX_ANSWER, &s, &a) == AP_REFUSED);
    // A buffer of AP_MAX_REPLY bytes with no end must end in a refusal, or the read loop has no way out.
    memset(longest + 3, 'a', AP_MAX_REPLY - 3);
    CHECK(parse(longest, AP_MAX_REPLY, &s, &a) == AP_REFUSED);

    unsigned char wiped[4] = {1, 2, 3, 4};
    ap_wipe(wiped, sizeof wiped);
    CHECK(!wiped[0] && !wiped[1] && !wiped[2] && !wiped[3]);

    srand(20261102);
    for (int round = 0; round < 200000; round++) {
        size_t len = (size_t)rand() % (AP_MAX_REPLY + 1);
        // Bytes that come near a whole frame often enough to matter.
        char *bytes = malloc(len ? len : 1);
        for (size_t i = 0; i < len; i++) bytes[i] = "OK\n\r\0a"[rand() % 6];
        if (len >= 3 && round % 2) memcpy(bytes, "OK\n", 3);
        s = a = 0;
        int r = ap_reply_parse(bytes, len, &s, &a);
        CHECK(r == AP_MORE || r == AP_OK || r == AP_REFUSED);
        if (r == AP_OK) CHECK(s == 3 && a >= 1 && a <= AP_MAX_ANSWER && s + a + 1 == len && bytes[s + a] == '\n');
        if (len == AP_MAX_REPLY) CHECK(r != AP_MORE);
        free(bytes);
    }
    for (int round = 0; round < 20000; round++) {
        size_t len = (size_t)rand() % 8000;
        char *text = malloc(len + 1);
        for (size_t i = 0; i < len; i++) text[i] = (char)(1 + rand() % 255);
        text[len] = 0;
        size_t cap = 1 + (size_t)rand() % AP_MAX_BODY;
        char *to = malloc(cap);
        if (ap_build_request(to, cap, &n, "ab", "", text)) CHECK(n <= cap && to[n - 1] == '\n' && !memchr(to, '\n', n - 1));
        free(to);
        ap_pipe_ok(text);
        ap_key_ok(text);
        free(text);
    }
    if (failures) return 1;
    printf("pass: the core of vibex-askpass\n");
    return 0;
}
