// vibex-askpass.exe: the SSH_ASKPASS program of every ssh that Vibex PCA starts on Windows (fork: Askpass/vibex-askpass.c).
//
// The app itself cannot be it: Electron writes a line end to stdout before any app code (electron_main_delegate.cc), and ssh cuts
// an answer at the first line end (readpass.c), so each answer would be empty. ssh runs this for its OWN prompts only, with the
// prompt as the one argument; text a server prints can never run it.
//
// It sends the prompt and this ssh's ticket as one framed line over the app's named pipe, and writes the answer to stdout with one
// newline and no other byte. Any failure or refusal: empty stdout and exit code 1, so ssh fails the login. It says nothing on stderr:
// what it never writes, no log can hold.
//
// Not as strong as the Swift helper: no check that the pipe's server is the app. The pipe name and the ticket are in this ssh's
// environment, so what can change them can also change this file or the ssh; the check would stop nothing more.
//
// No C runtime: kernel32 and shell32 only, a window subsystem so that no console opens, and static buffers wiped on each exit.
#include <windows.h>
#include <shellapi.h>

#include "askpass_core.h"

// A host key question waits for a person's hold (2 minutes in the app); a typed one as long.
#define WAIT_MS 180000
#define ENV_UNITS 512
#define PATH_UNITS 32768

static char body[AP_MAX_BODY];
static char reply[AP_MAX_REPLY];
static char prompt[AP_MAX_PROMPT + 1];
static char key[AP_MAX_KEY + 1];
static char hint[AP_MAX_HINT + 1];
static char pipe_name[AP_MAX_PIPE];
static WCHAR pipe_wide[AP_MAX_PIPE];
static WCHAR env_wide[ENV_UNITS];
static WCHAR path_wide[PATH_UNITS];
static WCHAR path_short[PATH_UNITS];
static char path_utf8[PATH_UNITS * 3];

// A base relocation in the image: with none, the linker marks it as unable to move, and ASLR has nothing to act on.
__attribute__((used)) static const void *const reloc_anchor = &reloc_anchor;

// The compiler may call these for its own copies, and no C library is here to give them.
void *memset(void *to, int value, size_t n) {
    unsigned char *p = to;
    while (n--) *p++ = (unsigned char)value;
    return to;
}
void *memcpy(void *to, const void *from, size_t n) {
    unsigned char *p = to;
    const unsigned char *q = from;
    while (n--) *p++ = *q++;
    return to;
}

static void wipe_all(void) {
    ap_wipe(reply, sizeof reply);
    ap_wipe(body, sizeof body);
    ap_wipe(key, sizeof key);
    ap_wipe(env_wide, sizeof env_wide);
}

static DWORD WINAPI watchdog(LPVOID unused) {
    (void)unused;
    Sleep(WAIT_MS);
    wipe_all();
    ExitProcess(1);
    return 1;
}

/// 1: read. 0: not set, too long, or not printable ASCII.
static int env_ascii(const WCHAR *name, char *out, size_t cap) {
    DWORD units = GetEnvironmentVariableW(name, env_wide, ENV_UNITS);
    if (units == 0 || units >= ENV_UNITS) return 0;
    return ap_ascii_from_utf16((const uint16_t *)env_wide, units, out, cap);
}

static int write_all(HANDLE to, const char *data, size_t length) {
    while (length > 0) {
        DWORD wrote = 0;
        DWORD part = length > 65536 ? 65536 : (DWORD)length;
        if (!WriteFile(to, data, part, &wrote, NULL) || wrote == 0) return 0;
        data += wrote;
        length -= wrote;
    }
    return 1;
}

/// The Windows ssh cannot start a path with letters outside ASCII, so the app asks for this program's short form (askpass.ts).
static int print_short_path(HANDLE out) {
    DWORD units = GetModuleFileNameW(NULL, path_wide, PATH_UNITS);
    if (units == 0 || units >= PATH_UNITS) return 1;
    units = GetShortPathNameW(path_wide, path_short, PATH_UNITS);
    if (units == 0 || units >= PATH_UNITS) return 1;
    int bytes = WideCharToMultiByte(CP_UTF8, 0, path_short, (int)units, path_utf8, (int)sizeof path_utf8, NULL, NULL);
    if (bytes <= 0) return 1;
    return write_all(out, path_utf8, (size_t)bytes) ? 0 : 1;
}

static HANDLE open_pipe(void) {
    int units = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, pipe_name, -1, pipe_wide, AP_MAX_PIPE);
    if (units <= 0) return INVALID_HANDLE_VALUE;
    for (int tries = 0; tries < 5; tries++) {
        // SECURITY_ANONYMOUS: the other end of the pipe cannot act as this user.
        HANDLE pipe = CreateFileW(pipe_wide, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS, NULL);
        if (pipe != INVALID_HANDLE_VALUE) return pipe;
        if (GetLastError() != ERROR_PIPE_BUSY) return INVALID_HANDLE_VALUE;
        WaitNamedPipeW(pipe_wide, 1000);
    }
    return INVALID_HANDLE_VALUE;
}

static int run(void) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (out == NULL || out == INVALID_HANDLE_VALUE) return 1;

    char flag[2];
    if (env_ascii(L"VIBEX_ASKPASS_SHORT_PATH", flag, sizeof flag) && flag[0] == '1') return print_short_path(out);

    // Not set is an empty hint. A value too long or not ASCII is not one that ssh sets.
    DWORD hint_units = GetEnvironmentVariableW(L"SSH_ASKPASS_PROMPT", env_wide, ENV_UNITS);
    if (hint_units >= ENV_UNITS) return 1;
    if (!ap_ascii_from_utf16((const uint16_t *)env_wide, hint_units, hint, sizeof hint)) return 1;
    // "none": ssh only shows a notice (touch a security key). Nothing to answer.
    if (hint[0] == 'n' && hint[1] == 'o' && hint[2] == 'n' && hint[3] == 'e' && hint[4] == 0) return 0;

    if (!env_ascii(L"VIBEX_ASKPASS_SOCKET", pipe_name, sizeof pipe_name) || !ap_pipe_ok(pipe_name)) return 1;
    if (!env_ascii(L"VIBEX_ASKPASS_KEY", key, sizeof key) || !ap_key_ok(key)) return 1;

    // ssh gives one argument. Two mean that its quoting of the prompt did not hold, so the text is not the prompt it meant.
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv == NULL || argc != 2) return 1;
    int bytes = WideCharToMultiByte(CP_UTF8, 0, argv[1], -1, prompt, AP_MAX_PROMPT + 1, NULL, NULL);
    if (bytes <= 1) return 1;

    size_t length = 0;
    if (!ap_build_request(body, sizeof body, &length, key, hint, prompt)) return 1;

    // A sync read has no time limit of its own.
    HANDLE timer = CreateThread(NULL, 0, watchdog, NULL, 0, NULL);
    if (timer == NULL) return 1;
    CloseHandle(timer);

    HANDLE pipe = open_pipe();
    if (pipe == INVALID_HANDLE_VALUE) return 1;
    // The pipe stays open both ways: on a Windows named pipe a half-close closes both ends (askpassHelper.ts).
    if (!write_all(pipe, body, length)) return 1;

    size_t have = 0, start = 0, answer = 0;
    for (;;) {
        int state = ap_reply_parse(reply, have, &start, &answer);
        if (state == AP_REFUSED) return 1;
        if (state == AP_OK) break;
        if (have >= sizeof reply) return 1;
        DWORD got = 0;
        if (!ReadFile(pipe, reply + have, (DWORD)(sizeof reply - have), &got, NULL) || got == 0) return 1;
        have += got;
    }
    CloseHandle(pipe);
    // The newline of the frame is the one newline of stdout. Straight to the pipe: no stdio buffer keeps a copy.
    return write_all(out, reply + start, answer + 1) ? 0 : 1;
}

__attribute__((noreturn)) void WINAPI ap_entry(void) {
    int code = run();
    wipe_all();
    ExitProcess((UINT)code);
}
