// vibex-presence.exe: asks Windows Hello (PIN, face or finger) whether the person at this PC is its owner, before Vibex PCA
// reads a saved server secret (savedSecretGate.ts; fork: Servers/DeviceAuthenticator.swift, PR #51).
//
// Usage: vibex-presence.exe <window handle, decimal> <message>. It prints one word on stdout and exits 0:
//   ok           Windows Hello verified the person.
//   no           the person cancelled, the tries ran out, or the device was busy.
//   unavailable  this PC has no Windows Hello set up, or anything failed. The app then asks the person to type the secret.
// Any other result (a crash, no output, another exit code) is 'unavailable' in the app. It never reads, takes or prints a
// password, and it says nothing on stderr.
//
// The app ends a prompt by closing this program's stdin (the limit, or the ssh that asked is gone). A watch thread sees the
// end of stdin, also when the app itself ends, and the poll loop then cancels the Windows Hello operation, so its prompt
// leaves the screen, and exits with no word. The watchdog does the same at its own limit. A kill alone would leave it open.
//
// WinRT from C with no C runtime: combase.dll is loaded from System32 by name at run time (only kernel32 and shell32 are
// imported), the interfaces are declared here by hand, and the asynchronous operation is polled through IAsyncInfo, because
// a completion handler would need a COM object of our own. The parameterised IIDs are derived from their WinRT signatures
// (tests/presence-gate.spec.ts recomputes them).
// Windows 10 or later: Windows Hello and the interop interface came with it.
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <shellapi.h>

#ifndef LOAD_LIBRARY_SEARCH_SYSTEM32
#define LOAD_LIBRARY_SEARCH_SYSTEM32 0x00000800
#endif

// The app closes stdin at 40 s; this ends by itself a little later in case that never comes.
#define WAIT_MS 45000
#define POLL_MS 50
// After a stop, the time the cancel gets before the process ends anyway.
#define CANCEL_MS 2000

// A base relocation in the image: with none, the linker marks it as unable to move, and ASLR has nothing to act on.
__attribute__((used)) static const void *const reloc_anchor = &reloc_anchor;

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

typedef struct vp_hstring_ *vp_HSTRING;

// IInspectable, then the interface's own methods, in vtable order.
#define VP_INSPECTABLE(T)                                                          \
    HRESULT (STDMETHODCALLTYPE *QueryInterface)(T *self, REFIID riid, void **out); \
    ULONG (STDMETHODCALLTYPE *AddRef)(T *self);                                    \
    ULONG (STDMETHODCALLTYPE *Release)(T *self);                                   \
    HRESULT (STDMETHODCALLTYPE *GetIids)(T *self, ULONG *count, IID **iids);       \
    HRESULT (STDMETHODCALLTYPE *GetRuntimeClassName)(T *self, vp_HSTRING *name);   \
    HRESULT (STDMETHODCALLTYPE *GetTrustLevel)(T *self, int *level);

// Windows.Foundation.IAsyncInfo
typedef struct vp_async_info vp_async_info;
typedef struct {
    VP_INSPECTABLE(vp_async_info)
    HRESULT (STDMETHODCALLTYPE *get_Id)(vp_async_info *self, UINT32 *id);
    HRESULT (STDMETHODCALLTYPE *get_Status)(vp_async_info *self, int *status);
    HRESULT (STDMETHODCALLTYPE *get_ErrorCode)(vp_async_info *self, HRESULT *code);
    HRESULT (STDMETHODCALLTYPE *Cancel)(vp_async_info *self);
    HRESULT (STDMETHODCALLTYPE *Close)(vp_async_info *self);
} vp_async_info_vtbl;
struct vp_async_info { const vp_async_info_vtbl *v; };

// Windows.Foundation.IAsyncOperation<enum>: both results here are 32-bit enums.
typedef struct vp_async_op vp_async_op;
typedef struct {
    VP_INSPECTABLE(vp_async_op)
    HRESULT (STDMETHODCALLTYPE *put_Completed)(vp_async_op *self, void *handler);
    HRESULT (STDMETHODCALLTYPE *get_Completed)(vp_async_op *self, void **handler);
    HRESULT (STDMETHODCALLTYPE *GetResults)(vp_async_op *self, INT32 *result);
} vp_async_op_vtbl;
struct vp_async_op { const vp_async_op_vtbl *v; };

// Windows.Security.Credentials.UI.IUserConsentVerifierStatics
typedef struct vp_statics vp_statics;
typedef struct {
    VP_INSPECTABLE(vp_statics)
    HRESULT (STDMETHODCALLTYPE *CheckAvailabilityAsync)(vp_statics *self, vp_async_op **op);
    HRESULT (STDMETHODCALLTYPE *RequestVerificationAsync)(vp_statics *self, vp_HSTRING message, vp_async_op **op);
} vp_statics_vtbl;
struct vp_statics { const vp_statics_vtbl *v; };

// IUserConsentVerifierInterop (userconsentverifierinterop.h): the desktop app's way to name the window the prompt belongs to.
typedef struct vp_interop vp_interop;
typedef struct {
    VP_INSPECTABLE(vp_interop)
    HRESULT (STDMETHODCALLTYPE *RequestVerificationForWindowAsync)(vp_interop *self, HWND window, vp_HSTRING message, REFIID riid, void **op);
} vp_interop_vtbl;
struct vp_interop { const vp_interop_vtbl *v; };

// {AF4F3F91-564C-4DDC-B8B5-973447627C65}
static const IID IID_statics = {0xaf4f3f91, 0x564c, 0x4ddc, {0xb8, 0xb5, 0x97, 0x34, 0x47, 0x62, 0x7c, 0x65}};
// {39E050C3-4E74-441A-8DC0-B81104DF949C}
static const IID IID_interop = {0x39e050c3, 0x4e74, 0x441a, {0x8d, 0xc0, 0xb8, 0x11, 0x04, 0xdf, 0x94, 0x9c}};
// {00000036-0000-0000-C000-000000000046}
static const IID IID_async_info = {0x00000036, 0x0000, 0x0000, {0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};
// IAsyncOperation<UserConsentVerificationResult>: {FD596FFD-2318-558F-9DBE-D21DF43764A5}
static const IID IID_op_result = {0xfd596ffd, 0x2318, 0x558f, {0x9d, 0xbe, 0xd2, 0x1d, 0xf4, 0x37, 0x64, 0xa5}};

enum { AVAILABLE = 0 };
enum { VERIFIED = 0, DEVICE_BUSY = 4, RETRIES_EXHAUSTED = 5, CANCELED = 6 };
enum { ASYNC_STARTED = 0, ASYNC_COMPLETED = 1 };

typedef HRESULT (WINAPI *ro_initialize_fn)(int type);
typedef HRESULT (WINAPI *ro_get_factory_fn)(vp_HSTRING class_id, REFIID iid, void **factory);
typedef HRESULT (WINAPI *create_string_fn)(const WCHAR *text, UINT32 length, vp_HSTRING *out);
typedef HRESULT (WINAPI *delete_string_fn)(vp_HSTRING text);

static ro_initialize_fn ro_initialize;
static ro_get_factory_fn ro_get_factory;
static create_string_fn create_string;
static delete_string_fn delete_string;

static const WCHAR CLASS_NAME[] = L"Windows.Security.Credentials.UI.UserConsentVerifier";

static HANDLE out_handle;
static HANDLE input;
/// Set by the stdin watch or the watchdog; the poll loop cancels the operation.
static volatile LONG stop_requested;

static void say(const char *word) {
    DWORD length = 0;
    while (word[length]) length++;
    DWORD wrote = 0;
    if (out_handle && out_handle != INVALID_HANDLE_VALUE) WriteFile(out_handle, word, length, &wrote, NULL);
}

static DWORD WINAPI watchdog(LPVOID unused) {
    (void)unused;
    Sleep(WAIT_MS);
    stop_requested = 1;
    Sleep(CANCEL_MS);
    ExitProcess(1);
    return 1;
}

/// Reads stdin until it ends: the app closed it, or the app is gone. Any byte that comes is ignored.
static DWORD WINAPI stdin_watch(LPVOID unused) {
    (void)unused;
    char bytes[64];
    for (;;) {
        DWORD got = 0;
        if (!ReadFile(input, bytes, sizeof bytes, &got, NULL) || got == 0) break;
    }
    stop_requested = 1;
    Sleep(CANCEL_MS);
    ExitProcess(1);
    return 1;
}

static UINT32 wide_length(const WCHAR *text) {
    UINT32 n = 0;
    while (text[n] && n < 4096) n++;
    return n;
}

/// The window handle the app passed: decimal digits only, not zero.
static HWND parse_window(const WCHAR *text) {
    unsigned long long value = 0;
    int digits = 0;
    for (; *text; text++, digits++) {
        if (*text < L'0' || *text > L'9' || digits >= 20) return NULL;
        unsigned long long next = value * 10 + (unsigned long long)(*text - L'0');
        if (next / 10 != value) return NULL;
        value = next;
    }
    return digits ? (HWND)(ULONG_PTR)value : NULL;
}

/// Waits for an operation and gives its 32-bit result. 0: it did not complete. A stop cancels it, which closes its prompt.
static int wait_result(vp_async_op *op, INT32 *result) {
    vp_async_info *info = NULL;
    if (FAILED(op->v->QueryInterface(op, &IID_async_info, (void **)&info)) || !info) return 0;
    int status = ASYNC_STARTED;
    for (;;) {
        if (stop_requested) {
            info->v->Cancel(info);
            info->v->Close(info);
            info->v->Release(info);
            ExitProcess(1);
        }
        if (FAILED(info->v->get_Status(info, &status))) status = -1;
        if (status != ASYNC_STARTED) break;
        Sleep(POLL_MS);
    }
    int ok = status == ASYNC_COMPLETED && SUCCEEDED(op->v->GetResults(op, result));
    info->v->Close(info);
    info->v->Release(info);
    return ok;
}

/// "ok", "no" or "unavailable".
static const char *verify(HWND window, const WCHAR *message) {
    HMODULE combase = LoadLibraryExW(L"combase.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!combase) return "unavailable";
    ro_initialize = (ro_initialize_fn)(void *)GetProcAddress(combase, "RoInitialize");
    ro_get_factory = (ro_get_factory_fn)(void *)GetProcAddress(combase, "RoGetActivationFactory");
    create_string = (create_string_fn)(void *)GetProcAddress(combase, "WindowsCreateString");
    delete_string = (delete_string_fn)(void *)GetProcAddress(combase, "WindowsDeleteString");
    if (!ro_initialize || !ro_get_factory || !create_string || !delete_string) return "unavailable";
    // RO_INIT_MULTITHREADED: no message loop here, and the operation is polled from this thread.
    if (FAILED(ro_initialize(1))) return "unavailable";

    const char *word = "unavailable";
    vp_HSTRING class_name = NULL, text = NULL;
    vp_statics *statics = NULL;
    vp_interop *interop = NULL;
    vp_async_op *check = NULL, *request = NULL;
    INT32 availability = -1, result = -1;

    if (FAILED(create_string(CLASS_NAME, wide_length(CLASS_NAME), &class_name))) goto done;
    if (FAILED(ro_get_factory(class_name, &IID_statics, (void **)&statics)) || !statics) goto done;
    if (FAILED(statics->v->CheckAvailabilityAsync(statics, &check)) || !check) goto done;
    if (!wait_result(check, &availability) || availability != AVAILABLE) goto done;
    if (FAILED(ro_get_factory(class_name, &IID_interop, (void **)&interop)) || !interop) goto done;
    if (FAILED(create_string(message, wide_length(message), &text))) goto done;
    if (FAILED(interop->v->RequestVerificationForWindowAsync(interop, window, text, &IID_op_result, (void **)&request)) || !request) goto done;
    if (!wait_result(request, &result)) goto done;
    if (result == VERIFIED) word = "ok";
    else if (result == CANCELED || result == RETRIES_EXHAUSTED || result == DEVICE_BUSY) word = "no";

done:
    if (request) request->v->Release(request);
    if (check) check->v->Release(check);
    if (interop) interop->v->Release(interop);
    if (statics) statics->v->Release(statics);
    if (text) delete_string(text);
    if (class_name) delete_string(class_name);
    return word;
}

static int run(void) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    out_handle = GetStdHandle(STD_OUTPUT_HANDLE);
    if (out_handle == NULL || out_handle == INVALID_HANDLE_VALUE) return 1;
    HANDLE timer = CreateThread(NULL, 0, watchdog, NULL, 0, NULL);
    if (timer == NULL) return 1;
    CloseHandle(timer);
    // With no stdin the app cannot stop the prompt early, so this does not ask at all.
    input = GetStdHandle(STD_INPUT_HANDLE);
    if (input == NULL || input == INVALID_HANDLE_VALUE) {
        say("unavailable\n");
        return 0;
    }
    HANDLE watch = CreateThread(NULL, 0, stdin_watch, NULL, 0, NULL);
    if (watch == NULL) return 1;
    CloseHandle(watch);

    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv == NULL || argc != 3) {
        say("unavailable\n");
        return 0;
    }
    HWND window = parse_window(argv[1]);
    if (!window || !argv[2][0]) {
        say("unavailable\n");
        return 0;
    }
    const char *word = verify(window, argv[2]);
    say(word[0] == 'o' ? "ok\n" : word[0] == 'n' ? "no\n" : "unavailable\n");
    return 0;
}

void vp_entry(void) {
    ExitProcess((UINT)run());
}
