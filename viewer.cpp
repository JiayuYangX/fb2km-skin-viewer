// fb2km skin viewer - serves a skin folder over http and opens the preview page.
//
//   fbsv.exe [skin] [audio]
//
// skin   a folder, a .fbskin file, or a skindef.txt inside a skin folder
// audio  an optional track; its tags fill the labels and it plays in the page
//
// The page, the icon and the version block are resources, see page.rc.

#include <iostream>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <exdisp.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <objbase.h>
#include <shldisp.h>
#include <servprov.h>
#include <wincodec.h>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")

#pragma comment(lib, "shell32.lib")

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <thread>
#include <fstream>
#include <map>
#include <functional>
#include <set>
#include <sstream>
#include <string>
#include <vector>
#include <regex>
#include <zlib.h>


#include <taglib/attachedpictureframe.h>
#include <taglib/audioproperties.h>
#include <taglib/fileref.h>
#include <taglib/flacfile.h>
#include <taglib/flacpicture.h>
#include <taglib/flacproperties.h>
#include <taglib/mp4properties.h>
#include <taglib/wavproperties.h>
#include <taglib/id3v2tag.h>
#include <taglib/mpegfile.h>
#include <taglib/mp4file.h>
#include <taglib/mp4item.h>
#include <taglib/mp4tag.h>
#include <taglib/tag.h>
#include <taglib/tfile.h>
#include <taglib/textidentificationframe.h>
#include <taglib/tpropertymap.h>
#include <taglib/xiphcomment.h>
#include <taglib/vorbisfile.h>

namespace fs = std::filesystem;
using std::string;
using std::vector;


// -------------------------------------------------------------- instances --
// Every run keeps a line in this file so a later launch can hand its arguments
// to the instance that is already serving instead of starting another one.
static fs::path instance_file() {
    static fs::path cached;
    if (!cached.empty()) return cached;
    wchar_t *base = nullptr;
    std::wstring dir;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &base))) {
        dir = base;
        CoTaskMemFree(base);
    }
    if (dir.empty()) dir = L".";
    fs::path folder = fs::path(dir) / L"fb2km-skin-viewer";
    std::error_code ec;
    fs::create_directories(folder, ec);
    cached = folder / L"instances.txt";
    return cached;
}

struct Instance {
    int pid = 0;
    int port = 0;
};

static std::vector<Instance> read_instances() {
    std::vector<Instance> out;
    std::ifstream f(instance_file());
    int pid = 0, port = 0;
    while (f >> pid >> port) out.push_back({pid, port});
    return out;
}

static void write_instances(const std::vector<Instance> &list) {
    std::ofstream f(instance_file(), std::ios::trunc);
    for (const auto &i : list) f << i.pid << ' ' << i.port << '\n';
}

static bool pid_alive(int pid) {
    HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)pid);
    if (!h) return false;
    const DWORD wait = WaitForSingleObject(h, 0);
    CloseHandle(h);
    return wait == WAIT_TIMEOUT;
}

// a short GET/POST to our own server; empty means "not there"
static string http_call(int port, const string &method, const string &path,
                        const string &body = "") {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return "";
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)port);
    a.sin_addr.s_addr = inet_addr("127.0.0.1");

    u_long nonblocking = 1;
    ioctlsocket(s, FIONBIO, &nonblocking);
    connect(s, (sockaddr *)&a, sizeof a);
    fd_set wf;
    FD_ZERO(&wf);
    FD_SET(s, &wf);
    timeval tv{0, 300000};                       // 300 ms is plenty on loopback
    if (select(0, nullptr, &wf, nullptr, &tv) <= 0) { closesocket(s); return ""; }
    int err = 0;
    int elen = sizeof err;
    getsockopt(s, SOL_SOCKET, SO_ERROR, (char *)&err, &elen);
    if (err) { closesocket(s); return ""; }

    nonblocking = 0;
    ioctlsocket(s, FIONBIO, &nonblocking);
    DWORD rcv = 400;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&rcv, sizeof rcv);

    string req = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n";
    if (!body.empty()) req += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    req += "\r\n";
    req += body;
    send(s, req.data(), (int)req.size(), 0);

    string out;
    char buf[4096];
    for (;;) {
        const int n = recv(s, buf, sizeof buf, 0);
        if (n <= 0) break;
        out.append(buf, (size_t)n);
        if (out.size() > (1u << 20)) break;
    }
    closesocket(s);
    return out;
}

// true when this port answers as one of ours
static bool is_ours(int port) {
    const string r = http_call(port, "GET", "/api/version");
    return r.find("\"app\":\"fbsv\"") != string::npos;
}

static string query_escape(const string &v) {
    string out;
    for (unsigned char c : v) {
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || c == '/' || c == ':') out += (char)c;
        else {
            char hex[8];
            sprintf(hex, "%%%02X", c);
            out += hex;
        }
    }
    return out;
}

// -------------------------------------------------------------------- cli --
#ifndef FBSV_VERSION
#define FBSV_VERSION "0.0.0.dev"
#endif

static const char *kProduct = "foobar2000 mobile Skin Viewer";
static const char *kVersion = FBSV_VERSION;
static const int kBasePort = 17800;

static bool g_vt = false;          // console understands ANSI escapes
static bool g_verbose = false;     // --debug: also print every request

static void enableVt() {
    // colours and links only where the terminal is known to understand them;
    // elsewhere the escapes would be printed as text
    wchar_t scratch[64] = {};
    const bool known = GetEnvironmentVariableW(L"WT_SESSION", scratch, 64) > 0 ||
                       GetEnvironmentVariableW(L"TERM_PROGRAM", scratch, 64) > 0 ||
                       GetEnvironmentVariableW(L"CONEMUANSI", scratch, 64) > 0;
    if (!known) return;
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD mode = 0;
    if (out && GetConsoleMode(out, &mode) &&
        SetConsoleMode(out, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING)) {
        g_vt = true;
    }
}

// a clickable link where the terminal supports it, plain text everywhere else
static string link(const string &text, const string &url) {
    if (!g_vt) return text;
    return "\x1b]8;;" + url + "\x1b\\" + text + "\x1b]8;;\x1b\\";
}

static string dim(const string &text) {
    return text;
}

static string bold(const string &text) {
    return text;                        // plain text: colours read badly when piped
}

// one line per event, so a long running console stays readable
static void logline(const char *fmt, ...) {
    SYSTEMTIME t;
    GetLocalTime(&t);
    printf("[%02d:%02d:%02d] ", t.wHour, t.wMinute, t.wSecond);
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    printf("\n");
    fflush(stdout);
}

static void usage() {
    printf("%s %s\n", kProduct, kVersion);
    printf("%s\n\n", dim("usage: fbsv [options] [skin | folder] [audio ...]").c_str());
    printf("  %-22s %s\n", "skin | folder", "a .fbskin package, a skin folder, or audio files");
    printf("\n%s\n", bold("options").c_str());
    printf("  %-22s %s\n", "-h, --help", "this text");
    printf("  %-22s %s\n", "-V, --version", "print the version");
    printf("  %-22s %s\n", "--no-open", "do not open a browser");
    printf("  %-22s %s\n", "--single", "refuse to start if another instance runs");
    printf("  %-22s %s\n", "--top", "keep the window on top");
    printf("  %-22s %s\n", "--debug", "open with ?debug in the address");
    printf("  %-22s %s\n", "fbsv.ini", "settings beside the exe: dev, status, bar, theme, lang,");
    printf("  %-22s %s\n", "", "port, single, open, debug, top, layout, tolerance");
    printf("  %-22s %s\n", "--register", "add .fbskin to the Open with list");
    printf("  %-22s %s\n", "--unregister", "remove it again");
    printf("\n%s\n", bold("view").c_str());
    printf("  %-22s %s\n", "-s, --skin <path>", "open this as the skin, whatever it looks like");
    printf("  %-22s %s\n", "-a, --audio <path>", "queue this as a track (may repeat)");
    printf("  %-22s %s\n", "-l, --list <path>", "queue this playlist (may repeat)");
    printf("  %-22s %s\n", "--dev auto|WxH", "follow the layout's size, or fix the screen");
    printf("  %-22s %s\n", "--st auto|px", "work the status bar height out, or set it");
    printf("  %-22s %s\n", "--bar 0|1", "draw the status bar");
    printf("  %-22s %s\n", "--theme auto|dark|light", "colour scheme");
    printf("  %-22s %s\n", "--lang zh|en", "interface language");
    printf("  %-22s %s\n", "--layout <name>", "pick this subskin by name, over fbsv.ini");
    printf("\n%s\n", dim("examples").c_str());
    printf("  fbsv skin.fbskin                open a package\n");
    printf("  fbsv %s\n", "fb2km-skin.Eclipse\\dark");
    printf("  fbsv skin.fbskin song.flac      open a skin and queue music\n");
}


#pragma comment(lib, "ws2_32.lib")


// ------------------------------------------------------------------ basics --
static string read_file(const fs::path &p) {
    std::ifstream f(p, std::ios::binary);
    return string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

static string lower(string s) {
    for (auto &c : s) c = (char)tolower((unsigned char)c);
    return s;
}

static string ext_of(const string &name) {
    auto dot = name.find_last_of('.');
    return dot == string::npos ? "" : lower(name.substr(dot));
}


// 1..5 for image types, 0 otherwise
static int hash_ext(const string &e) {
    if (e == ".png") return 1;
    if (e == ".jpg" || e == ".jpeg") return 2;
    if (e == ".webp") return 3;
    if (e == ".gif") return 4;
    if (e == ".svg") return 5;
    return 0;
}

static string mime_of(const string &name) {
    static const std::map<string, string> m = {
        {".html", "text/html; charset=utf-8"}, {".htm", "text/html; charset=utf-8"},
        {".png", "image/png"},     {".jpg", "image/jpeg"},  {".jpeg", "image/jpeg"},
        {".txt", "text/plain; charset=utf-8"},
        {".mp3", "audio/mpeg"},    {".flac", "audio/flac"}, {".m4a", "audio/mp4"},
        {".aac", "audio/aac"},     {".ogg", "audio/ogg"},   {".opus", "audio/ogg"},
        {".wav", "audio/wav"},     {".wv", "audio/x-wavpack"},
    };
    auto it = m.find(ext_of(name));
    return it == m.end() ? "application/octet-stream" : it->second;
}

static string json_escape(const string &s) {
    string o;
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) {
                    char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b;
                } else o += (char)c;
        }
    }
    return o;
}

static string utf8(const std::wstring &w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
    return s;
}

static std::wstring wide(const string &s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
    return w;
}

// latin1 / utf16 helpers for tags
static string from_utf16(const uint8_t *p, size_t n, bool be) {
    std::wstring w;
    for (size_t i = 0; i + 1 < n; i += 2) {
        uint16_t c = be ? (uint16_t)((p[i] << 8) | p[i + 1]) : (uint16_t)(p[i] | (p[i + 1] << 8));
        w.push_back((wchar_t)c);
    }
    return utf8(w);
}

static string from_latin1(const uint8_t *p, size_t n) {
    std::wstring w;
    for (size_t i = 0; i < n; i++) w.push_back((wchar_t)p[i]);
    return utf8(w);
}

// --------------------------------------------------------------------- zip --
struct ZipEntry {
    string name;
    vector<uint8_t> data;
};


static bool read_zip(const vector<uint8_t> &buf, vector<ZipEntry> &out, vector<string> &skipped);

// The old designer did not write a zip: its packages are a run of records, each
// beginning with "DGC" and a flag byte, then the name length, the data length,
// the name and the data. Every entry in the samples is stored, flag 08.
static bool read_dgc(const vector<uint8_t> &buf, vector<ZipEntry> &out, vector<string> &skipped) {
    auto u32 = [&](size_t o) {
        return (uint32_t)buf[o] | ((uint32_t)buf[o + 1] << 8) | ((uint32_t)buf[o + 2] << 16) |
               ((uint32_t)buf[o + 3] << 24);
    };
    size_t off = 0;
    while (off + 12 <= buf.size()) {
        if (buf[off] != 'D' || buf[off + 1] != 'G' || buf[off + 2] != 'C') return false;
        const uint8_t flag = buf[off + 3];
        const uint32_t nameLen = u32(off + 4);
        const uint32_t dataLen = u32(off + 8);
        if (nameLen > 4096 || off + 12 + nameLen + dataLen > buf.size()) return false;
        string name((const char *)&buf[off + 12], nameLen);
        const size_t start = off + 12 + nameLen;
        if (flag == 0x08) {
            out.push_back({name, vector<uint8_t>(buf.begin() + start, buf.begin() + start + dataLen)});
        } else {
            skipped.push_back(name);
        }
        off = start + dataLen;
    }
    return !out.empty();
}

// zip is the current container, DGC the old one
static bool read_package(const vector<uint8_t> &buf, vector<ZipEntry> &out, vector<string> &skipped) {
    if (buf.size() > 3 && buf[0] == 'D' && buf[1] == 'G' && buf[2] == 'C') {
        return read_dgc(buf, out, skipped);
    }
    return read_zip(buf, out, skipped);
}

// .fbskin packages are stored (uncompressed); deflated entries are reported
static bool read_zip(const vector<uint8_t> &buf, vector<ZipEntry> &out, vector<string> &skipped) {
    auto u32 = [&](size_t o) {
        return (uint32_t)buf[o] | ((uint32_t)buf[o + 1] << 8) | ((uint32_t)buf[o + 2] << 16) |
               ((uint32_t)buf[o + 3] << 24);
    };
    auto u16 = [&](size_t o) { return (uint16_t)(buf[o] | (buf[o + 1] << 8)); };

    if (buf.size() < 22) return false;
    size_t eocd = string::npos;
    for (size_t i = buf.size() - 22; i + 22 <= buf.size(); i--) {
        if (u32(i) == 0x06054b50) { eocd = i; break; }
        if (i == 0) break;
    }
    if (eocd == string::npos) return false;

    size_t count = u16(eocd + 10);
    size_t p = u32(eocd + 16);
    for (size_t n = 0; n < count; n++) {
        if (p + 46 > buf.size() || u32(p) != 0x02014b50) break;
        uint16_t method = u16(p + 10);
        uint32_t csize = u32(p + 20);
        // the uncompressed size belongs to this entry and has to be read before p
        // moves on; read afterwards it was the next entry's, and a deflated file
        // followed by a smaller one could not be inflated into a buffer that size
        uint32_t usize = u32(p + 24);
        uint16_t nlen = u16(p + 28), elen = u16(p + 30), clen = u16(p + 32);
        uint32_t lho = u32(p + 42);
        string name((const char *)&buf[p + 46], nlen);
        p += 46 + nlen + elen + clen;
        if (!name.empty() && name.back() == '/') continue;
        if (method != 0 && method != 8) { skipped.push_back(name); continue; }
        if (lho + 30 > buf.size() || u32(lho) != 0x04034b50) continue;
        uint16_t lnlen = u16(lho + 26), lelen = u16(lho + 28);
        size_t start = lho + 30 + lnlen + lelen;
        if (start + csize > buf.size()) continue;
        ZipEntry e;
        e.name = name;
        if (method == 0) {
            e.data.assign(buf.begin() + start, buf.begin() + start + csize);
        } else {
            // deflate: most skins published for the app use it
            z_stream zs{};
            if (inflateInit2(&zs, -MAX_WBITS) != Z_OK) { skipped.push_back(name); continue; }
            if (usize == 0) usize = csize * 8;
            e.data.resize(usize);
            zs.next_in = const_cast<Bytef *>(buf.data() + start);
            zs.avail_in = csize;
            zs.next_out = e.data.data();
            zs.avail_out = (uInt)e.data.size();
            int rc = inflate(&zs, Z_FINISH);
            size_t produced = e.data.size() - zs.avail_out;
            inflateEnd(&zs);
            if (rc != Z_STREAM_END && rc != Z_OK) { skipped.push_back(name); continue; }
            e.data.resize(produced);
        }
        out.push_back(std::move(e));
    }
    return true;
}

static string trim(string s) {
    while (!s.empty() && (s.back() == '\r' || s.back() == ' ' || s.back() == '\t')) s.pop_back();
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) i++;
    return s.substr(i);
}

// ---------------------------------------------------------------- settings --

// fbsv.ini sits next to fbsv.exe: plain "key = value" lines, # and ; comment.
struct Settings {
    string dev, st, bar, lang, theme;      // empty means "not in the file"
    int port = 0;
    bool single = false, open = true, debug = false, top = false;
    std::vector<string> layouts;           // preferred subskin ratios, in order
    double tolerance = 15.0;               // percent
    bool loaded = false;                   // a file was found and read
    string path;                           // where it was, for the banner
};
static Settings g_cfg;

static fs::path exe_dir() {
    wchar_t buf[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, buf, MAX_PATH);
    return fs::path(buf).parent_path();
}

static bool config_bool(const string &v, bool &out) {
    const string t = lower(v);
    if (t == "on" || t == "1" || t == "yes" || t == "true") { out = true; return true; }
    if (t == "off" || t == "0" || t == "no" || t == "false") { out = false; return true; }
    return false;
}

static void load_config() {
    const fs::path file = exe_dir() / L"fbsv.ini";
    std::error_code ec;
    if (!fs::exists(file, ec)) return;
    string text = read_file(file);
    g_cfg.loaded = true;
    g_cfg.path = utf8(file.wstring());
    if (text.size() >= 3 && (unsigned char)text[0] == 0xEF &&
        (unsigned char)text[1] == 0xBB && (unsigned char)text[2] == 0xBF)
        text.erase(0, 3);                  // a BOM from an editor is not part of the key
    std::istringstream in(text);
    string raw;
    int line = 0;
    while (std::getline(in, raw)) {
        ++line;
        const string row = trim(raw);
        if (row.empty() || row[0] == '#' || row[0] == ';') continue;
        const size_t eq = row.find('=');
        if (eq == string::npos) {
            fprintf(stderr, "fbsv.ini:%d: expected key = value\n", line);
            continue;
        }
        const string key = lower(trim(row.substr(0, eq)));
        const string val = trim(row.substr(eq + 1));
        auto bad = [&](const char *want) {
            fprintf(stderr, "fbsv.ini:%d: %s wants %s, not \"%s\"\n",
                    line, key.c_str(), want, val.c_str());
        };
        if (key == "layout") {
            if (!val.empty()) g_cfg.layouts.push_back(val);
        } else if (key == "tolerance") {
            char *end = nullptr;
            const double d = std::strtod(val.c_str(), &end);
            if (end && !*end && d >= 0) g_cfg.tolerance = d;
            else bad("a percentage");
        } else if (key == "dev") {
            if (val == "auto" || std::regex_match(val, std::regex("[0-9]+x[0-9]+"))) g_cfg.dev = val;
            else bad("auto or WxH");
        } else if (key == "status" || key == "st") {
            if (val == "auto" || std::regex_match(val, std::regex("[0-9]+"))) g_cfg.st = val;
            else bad("auto or a number");
        } else if (key == "bar") {
            if (val == "0" || val == "1") g_cfg.bar = val;
            else bad("0 or 1");
        } else if (key == "theme") {
            if (val == "auto" || val == "dark" || val == "light") g_cfg.theme = val;
            else bad("auto, dark or light");
        } else if (key == "lang") {
            if (val == "zh" || val == "en") g_cfg.lang = val;
            else bad("zh or en");
        } else if (key == "port") {
            const int p = atoi(val.c_str());
            if (p > 0 && p < 65536) g_cfg.port = p;
            else bad("a port number");
        } else if (key == "single" || key == "open" || key == "debug" || key == "top") {
            bool b = false;
            if (!config_bool(val, b)) { bad("on or off"); continue; }
            if (key == "single") g_cfg.single = b;
            else if (key == "open") g_cfg.open = b;
            else if (key == "debug") g_cfg.debug = b;
            else g_cfg.top = b;
        } else {
            fprintf(stderr, "fbsv.ini:%d: unknown key \"%s\"\n", line, key.c_str());
        }
    }
}

static string settings_json() {
    std::ostringstream o;
    o << "{\"layouts\":[";
    for (size_t k = 0; k < g_cfg.layouts.size(); k++) {
        if (k) o << ",";
        o << "\"" << json_escape(g_cfg.layouts[k]) << "\"";
    }
    o << "],\"tolerance\":" << g_cfg.tolerance << "}";
    return o.str();
}


static bool is_audio(const fs::path &p) {
    static const char *exts[] = {".flac", ".mp3", ".m4a", ".mp4", ".aac", ".ogg",
                                 ".opus", ".wav", ".wv", ".aiff", ".dsf", ".alac"};
    string e = lower(p.extension().string());
    for (auto *x : exts) if (e == x) return true;
    return false;
}

static bool is_playlist_ext(const fs::path &p) {
    string e = lower(p.extension().string());
    return e == ".m3u" || e == ".m3u8" || e == ".pls";
}

static bool is_playlist(const fs::path &p) {
    string e = lower(p.extension().string());
    return e == ".m3u" || e == ".m3u8" || e == ".pls";
}

// m3u / m3u8: one path per line, # starts a comment, relative to the list
static std::vector<fs::path> read_playlist(const fs::path &list) {
    std::vector<fs::path> out;
    std::string raw = read_file(list);
    if (raw.size() > 3 && (unsigned char)raw[0] == 0xEF && (unsigned char)raw[1] == 0xBB &&
        (unsigned char)raw[2] == 0xBF) {
        raw = raw.substr(3);                       // utf-8 BOM
    }
    std::istringstream in(raw);
    std::string line;
    fs::path base = list.parent_path();
    while (std::getline(in, line)) {
        line = trim(line);
        if (line.empty() || line[0] == '#') continue;
        fs::path p = fs::path(wide(line));
        if (p.is_relative()) p = base / p;
        if (fs::is_regular_file(p) && is_audio(p)) out.push_back(fs::absolute(p));
    }
    return out;
}


// -------------------------------------------------------------------- tags --
// Artwork only ever lands in a few hundred pixels on screen, but a scanned cover
// can be eight megabytes and four thousand pixels wide; the browser then paints
// it over several frames. Shrink it once, on the way out.
static std::string shrink_jpeg(const std::vector<uint8_t> &in, int maxSide) {
    std::string out;
    if (in.empty()) return out;
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    IWICImagingFactory *fac = nullptr;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&fac))))
        return out;
    IStream *src = nullptr;
    if (SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &src))) {
        ULONG wrote = 0;
        src->Write(in.data(), (ULONG)in.size(), &wrote);
        LARGE_INTEGER zero{};
        src->Seek(zero, STREAM_SEEK_SET, nullptr);
        IWICBitmapDecoder *dec = nullptr;
        if (SUCCEEDED(fac->CreateDecoderFromStream(src, nullptr, WICDecodeMetadataCacheOnLoad, &dec))) {
            IWICBitmapFrameDecode *frame = nullptr;
            if (SUCCEEDED(dec->GetFrame(0, &frame))) {
                UINT w = 0, h = 0;
                frame->GetSize(&w, &h);
                double k = (w || h) ? std::min(1.0, (double)maxSide / (double)std::max(w, h)) : 1.0;
                UINT tw = (UINT)std::max(1.0, w * k), th = (UINT)std::max(1.0, h * k);
                IWICBitmapScaler *scaler = nullptr;
                if (k < 0.999 && SUCCEEDED(fac->CreateBitmapScaler(&scaler)) &&
                    SUCCEEDED(scaler->Initialize(frame, tw, th, WICBitmapInterpolationModeFant))) {
                    IStream *dst = nullptr;
                    if (SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &dst))) {
                        IWICBitmapEncoder *enc = nullptr;
                        if (SUCCEEDED(fac->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &enc)) &&
                            SUCCEEDED(enc->Initialize(dst, WICBitmapEncoderNoCache))) {
                            IWICBitmapFrameEncode *ef = nullptr;
                            IPropertyBag2 *props = nullptr;
                            if (SUCCEEDED(enc->CreateNewFrame(&ef, &props))) {
                                ef->Initialize(props);
                                ef->SetSize(tw, th);
                                WICPixelFormatGUID fmt = GUID_WICPixelFormat24bppBGR;
                                ef->SetPixelFormat(&fmt);
                                if (SUCCEEDED(ef->WriteSource(scaler, nullptr)) &&
                                    SUCCEEDED(ef->Commit()) && SUCCEEDED(enc->Commit())) {
                                    STATSTG st{};
                                    if (SUCCEEDED(dst->Stat(&st, STATFLAG_NONAME)) && st.cbSize.QuadPart) {
                                        HGLOBAL hg = nullptr;
                                        if (SUCCEEDED(GetHGlobalFromStream(dst, &hg)) && hg) {
                                            void *mem = GlobalLock(hg);
                                            if (mem) {
                                                out.assign((const char *)mem, (size_t)st.cbSize.QuadPart);
                                                GlobalUnlock(hg);
                                            }
                                        }
                                    }
                                }
                                ef->Release();
                                if (props) props->Release();
                            }
                            enc->Release();
                        }
                        dst->Release();
                    }
                    scaler->Release();
                }
                frame->Release();
            }
            dec->Release();
        }
        src->Release();
    }
    fac->Release();
    return out;
}

struct Media {
    bool ok = false;
    string container, title, artist, album, year, composer;
    int bits = 0, rate = 0, channels = 0, bitrate = 0;
    double seconds = 0;
    double rg_track = 0, rg_album = 0;
    bool has_rg = false;
    string cover_mime;
    vector<uint8_t> cover;
};

static double parse_gain(const string &value) {
    string v = value;
    auto pos = v.find("dB");
    if (pos != string::npos) v = v.substr(0, pos);
    try { return std::stod(v); } catch (...) { return 0; }
}

static string sniff_mime(const vector<uint8_t> &b) {
    if (b.size() > 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
    if (b.size() > 3 && b[0] == 0xFF && b[1] == 0xD8) return "image/jpeg";
    return "image/jpeg";
}

static string container_of(const fs::path &p) {
    string e = lower(p.extension().string());
    static const std::map<string, string> names = {
        {".flac", "FLAC"}, {".mp3", "MP3"},  {".m4a", "M4A"},   {".mp4", "M4A"},
        {".aac", "AAC"},   {".ogg", "OGG"},  {".opus", "OPUS"}, {".wav", "WAV"},
        {".wv", "WAVPACK"}, {".aiff", "AIFF"}, {".dsf", "DSF"},
    };
    auto it = names.find(e);
    return it == names.end() ? (e.empty() ? "audio" : e.substr(1)) : it->second;
}

static string mmss(double seconds) {
    int total = (int)seconds;      // floor, like every player shows it
    char buf[16];
    std::snprintf(buf, sizeof buf, "%d:%02d", total / 60, total % 60);
    return buf;
}

static Media read_media(const fs::path &path) {
    Media m;
    m.container = container_of(path);

    TagLib::FileRef ref(path.c_str(), true, TagLib::AudioProperties::Accurate);
    if (ref.isNull() || !ref.file()) return m;
    m.ok = true;

    if (auto *ap = ref.audioProperties()) {
        m.rate = ap->sampleRate();
        m.channels = ap->channels();
        m.bitrate = ap->bitrate();
        m.seconds = ap->lengthInMilliseconds() / 1000.0;
        // bit depth only exists on the format specific property classes
        if (auto *flac = dynamic_cast<TagLib::FLAC::Properties *>(ap)) m.bits = flac->bitsPerSample();
        else if (auto *mp4 = dynamic_cast<TagLib::MP4::Properties *>(ap)) m.bits = mp4->bitsPerSample();
        else if (auto *wav = dynamic_cast<TagLib::RIFF::WAV::Properties *>(ap)) m.bits = wav->bitsPerSample();
    }
    if (auto *tag = ref.tag()) {
        m.title = tag->title().to8Bit(true);
        m.artist = tag->artist().to8Bit(true);
        m.album = tag->album().to8Bit(true);
        if (auto y = tag->year(); y > 0) m.year = std::to_string(y);
    }

    // vorbis comments and anything else TagLib exposes as a property
    auto take = [&](const string &rawKey, const string &value) {
        string k = lower(rawKey);
        if (k == "replaygain_track_gain") { m.rg_track = parse_gain(value); m.has_rg = true; }
        else if (k == "replaygain_album_gain") { m.rg_album = parse_gain(value); m.has_rg = true; }
        else if (k == "date" && !value.empty()) m.year = value.substr(0, 10);
    };
    auto props = ref.file()->properties();
    for (auto it = props.begin(); it != props.end(); ++it) {
        auto v = it->second;
        if (!v.isEmpty()) take(it->first.to8Bit(true), v.front().to8Bit(true));
    }

    // ID3 stores gain in TXXX frames, which are not part of the property map
    if (auto *mp3 = dynamic_cast<TagLib::MPEG::File *>(ref.file())) {
        if (auto *id3 = mp3->ID3v2Tag()) {
            for (auto *frame : id3->frameList("TXXX")) {
                auto *user = dynamic_cast<TagLib::ID3v2::UserTextIdentificationFrame *>(frame);
                if (!user) continue;
                auto fields = user->fieldList();
                if (fields.size() >= 2) take(fields[0].to8Bit(true), fields[1].to8Bit(true));
            }
        }
    }
    // MP4 keeps them as free form atoms
    if (auto *mp4 = dynamic_cast<TagLib::MP4::File *>(ref.file())) {
        if (auto *tag = mp4->tag()) {
            auto items = tag->itemMap();
            for (auto it = items.begin(); it != items.end(); ++it) {
                string key = it->first.to8Bit(true);
                auto cut = key.find_last_of(':');
                if (cut != string::npos) key = key.substr(cut + 1);
                auto values = it->second.toStringList();
                if (!values.isEmpty()) take(key, values.front().to8Bit(true));
            }
        }
    }

    // cover art
    auto set_cover = [&](const TagLib::ByteVector &data, const string &mime) {
        if (data.isEmpty()) return;
        m.cover.assign((const uint8_t *)data.data(), (const uint8_t *)data.data() + data.size());
        m.cover_mime = mime.empty() || mime == "image/" ? sniff_mime(m.cover) : mime;
    };

    if (auto *flac = dynamic_cast<TagLib::FLAC::File *>(ref.file())) {
        auto pics = flac->pictureList();
        if (!pics.isEmpty()) set_cover(pics.front()->data(), pics.front()->mimeType().to8Bit(true));
    } else if (auto *mp3 = dynamic_cast<TagLib::MPEG::File *>(ref.file())) {
        if (auto *id3 = mp3->ID3v2Tag()) {
            for (auto *frame : id3->frameList("APIC")) {
                auto *pic = dynamic_cast<TagLib::ID3v2::AttachedPictureFrame *>(frame);
                if (pic) { set_cover(pic->picture(), pic->mimeType().to8Bit(true)); break; }
            }
        }
    } else if (auto *mp4 = dynamic_cast<TagLib::MP4::File *>(ref.file())) {
        if (auto *tag = mp4->tag()) {
            auto items = tag->itemMap();
            auto it = items.find("covr");
            if (it != items.end()) {
                auto list = it->second.toCoverArtList();
                if (!list.isEmpty()) set_cover(list.front().data(), "");
            }
        }
    } else if (auto *ogg = dynamic_cast<TagLib::Ogg::Vorbis::File *>(ref.file())) {
        if (auto *tag = ogg->tag()) {
            auto pics = tag->pictureList();
            if (!pics.isEmpty()) set_cover(pics.front()->data(), pics.front()->mimeType().to8Bit(true));
        }
    }
    if (!m.cover.empty() && m.cover_mime.rfind("image/", 0) != 0) m.cover_mime = sniff_mime(m.cover);
    return m;
}



// ---------------------------------------------------------------- pickers --
// the dialog only exists after Show(); a small helper keeps pulling it to the
// front until it owns the focus, which is what the foreground lock otherwise
// keeps handing back to the browser
static void pull_to_front(std::wstring title) {
    for (int i = 0; i < 60; i++) {
        Sleep(50);
        HWND dlg = FindWindowW(L"#32770", title.c_str());
        if (!dlg) {
            // the common dialog titles are localised; fall back to any owned popup
            dlg = FindWindowW(L"#32770", nullptr);
        }
        if (!dlg || !IsWindowVisible(dlg)) continue;
        if (GetForegroundWindow() == dlg) return;
        HWND fg = GetForegroundWindow();
        DWORD fgThread = fg ? GetWindowThreadProcessId(fg, nullptr) : 0;
        DWORD myThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread && fgThread != myThread) attached = AttachThreadInput(fgThread, myThread, TRUE) != 0;
        SetWindowPos(dlg, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        SetForegroundWindow(dlg);
        SetActiveWindow(dlg);
        SetFocus(dlg);
        if (attached) AttachThreadInput(fgThread, myThread, FALSE);
    }
}


// the exe runs on the same desktop as the browser, so it can show the real
// Windows dialog and hand back a path the browser is not allowed to know
// one picker at a time: a second request finds the first one still open and
// gives up instead of stacking another window
static std::atomic<bool> g_picking{false};

static std::vector<std::wstring> pick_paths(bool folder, const wchar_t *filter, const wchar_t *title,
                                            bool multi, bool *busy = nullptr) {
    if (g_picking.exchange(true)) {
        if (busy) *busy = true;
        return {};
    }
    struct Reset { ~Reset() { g_picking = false; } } reset;
    if (busy) *busy = false;
    std::vector<std::wstring> chosen;
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    bool uninit = SUCCEEDED(hr);
    IFileOpenDialog *dlg = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_PPV_ARGS(&dlg))) && dlg) {
        DWORD opts = 0;
        dlg->GetOptions(&opts);
        DWORD want = opts | FOS_FORCEFILESYSTEM | (folder ? FOS_PICKFOLDERS : FOS_FILEMUSTEXIST);
        if (multi) want |= FOS_ALLOWMULTISELECT;
        dlg->SetOptions(want);
        if (title) dlg->SetTitle(title);
        if (!folder && filter) {
            COMDLG_FILTERSPEC spec[] = {{title ? title : L"files", filter}};
            dlg->SetFileTypes(1, spec);
        }
        // an owned dialog sits above its owner; a topmost hidden owner therefore
        // keeps the picker in front of the browser
        // an owner that never activates keeps the dialog above without stealing
        // focus from itself
        HWND owner = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                                     L"STATIC", L"picker", WS_POPUP, 0, 0, 1, 1,
                                     nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);

        // the user clicked inside the browser, so Windows will not let this
        // process take the foreground; borrow the browser's input queue briefly
        if (owner) {
            HWND fg = GetForegroundWindow();
            DWORD fgThread = fg ? GetWindowThreadProcessId(fg, nullptr) : 0;
            DWORD myThread = GetCurrentThreadId();
            bool attached = false;
            if (fgThread && fgThread != myThread)
                attached = AttachThreadInput(fgThread, myThread, TRUE) != 0;
            SetForegroundWindow(owner);
            SetActiveWindow(owner);
            if (attached) AttachThreadInput(fgThread, myThread, FALSE);
        }
        {
            std::wstring t = title ? title : L"";
            std::thread(pull_to_front, t).detach();
        }
        if (SUCCEEDED(dlg->Show(owner ? owner : GetConsoleWindow()))) {
            auto take = [&](IShellItem *item) {
                if (!item) return;
                PWSTR path = nullptr;
                if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) {
                    chosen.push_back(path);
                    CoTaskMemFree(path);
                }
                item->Release();
            };
            IShellItemArray *many = nullptr;
            if (multi && SUCCEEDED(dlg->GetResults(&many)) && many) {
                DWORD count = 0;
                many->GetCount(&count);
                for (DWORD i = 0; i < count; i++) {
                    IShellItem *one = nullptr;
                    if (SUCCEEDED(many->GetItemAt(i, &one))) take(one);
                }
                many->Release();
            } else {
                IShellItem *item = nullptr;
                if (SUCCEEDED(dlg->GetResult(&item))) take(item);
            }
        }
        dlg->Release();
        if (owner) DestroyWindow(owner);
    }
    if (uninit) CoUninitialize();
    return chosen;
}

// ---------------------------------------------------------------- listing --
struct SkinSource {
    string label;                     // what the page shows and what the url carries
    fs::path root;                    // a folder, or a package name for display
    std::map<string, string> files;   // package contents
};

struct Track {
    int id;              // stable for the lifetime of the session, never reused
    fs::path path;
};

struct Session {
    std::vector<SkinSource> sources;  // every skin opened so far
    size_t active = 0;
    fs::path root;
    std::map<string, string> files;   // package contents, served from memory

    std::vector<Track> tracks;        // the playlist, in order
    int nextId = 1;
    int playingId = -1;               // what the element is playing, by identity
    fs::path playingPath;             // kept even when its row is deleted
    int anchor = -1;                  // position of a deleted, still playing row
    std::map<int, Media> cache;
    std::map<int, std::string> thumbs;       // tags by track id

    int indexOf(int id) const {
        for (size_t i = 0; i < tracks.size(); i++)
            if (tracks[i].id == id) return (int)i;
        return -1;
    }
    // where a jump starts from: the playing row, or the slot it used to occupy
    int playPos() const {
        int p = indexOf(playingId);
        return p >= 0 ? p : anchor;
    }
    bool hasSlot() const {
        int p = playPos();
        return p >= 0 && p < (int)tracks.size();
    }
    bool empty() const { return tracks.empty() && playingPath.empty(); }

    // Whoever needs to know "what plays now" calls this: the id is the answer
    // while it is in the list; when it is gone and nothing is loaded, the slot
    // it used to occupy decides, and that is the moment the anchor is consumed.
    void resolve() {
        // nothing is loaded, so a decision is due; once it is made the anchor has
        // served its purpose either way - when the id was still found it was not
        // even needed, which is the better outcome
        if (!playingPath.empty()) return;          // a deleted row is still sounding
        if (indexOf(playingId) >= 0) { anchor = -1; return; }   // the id is there
        if (anchor >= 0 && anchor < (int)tracks.size()) {
            playingId = tracks[anchor].id;                       // the anchor was used
            anchor = -1;
            return;
        }
        // neither worked: forget the track but keep the anchor, so the next file
        // that arrives still knows which row it belongs to
        playingId = -1;
    }

    const fs::path &playing() const {
        static const fs::path none;
        if (!playingPath.empty()) return playingPath;
        // nothing loaded yet: the row the id points at is what /media serves
        int p = indexOf(playingId);
        if (p < 0) p = playPos();
        return (p >= 0 && p < (int)tracks.size()) ? tracks[p].path : none;
    }

    // a dropped file goes where it was dropped
    void insert(const fs::path &p, int at) {
        int id = nextId++;
        size_t pos = at < 0 ? 0 : (size_t)at;
        if (pos > tracks.size()) pos = tracks.size();
        tracks.insert(tracks.begin() + pos, Track{id, p});
        if (playingId < 0) playingId = id;      // the first track becomes current
    }

    // emptying the list also resets the position: whatever fills it next starts
    // on its first row, and a later stop resumes there
    void clear_list() {
        bool sounding = !playingPath.empty();
        tracks.clear();
        cache.clear();
        anchor = 0;
        if (!sounding) playingId = -1;
    }

    int add(const fs::path &p) {
        int id = nextId++;
        tracks.push_back({id, p});
        // nothing was current, so the track that just arrived is: pressing play
        // then starts the first one without picking a row by hand
        if (playingId < 0) playingId = id;
        return id;
    }

    // the shrunk artwork, built once per track
    const std::string &thumb_of(int id) {
        auto it = thumbs.find(id);
        if (it != thumbs.end()) return it->second;
        const Media &m = meta_of(id);
        std::string t;
        // small art is fine as it is; only the heavy files are worth a pass
        if (m.cover.size() > 160 * 1024) t = shrink_jpeg(m.cover, 640);
        return thumbs.emplace(id, std::move(t)).first->second;
    }

    const Media &meta_of(int id) {
        static const Media blank;
        auto it = cache.find(id);
        if (it != cache.end()) return it->second;
        int pos = indexOf(id);
        if (pos < 0) return blank;
        return cache.emplace(id, read_media(tracks[pos].path)).first->second;
    }
    const Media &now_meta() {
        static const Media blank;
        int id = playingId;
        if (id >= 0 && indexOf(id) >= 0) return meta_of(id);
        if (playingPath.empty()) return blank;
        static Media once;
        static string for_path;
        string now = playingPath.string();
        if (for_path != now) { once = read_media(playingPath); for_path = now; }
        return once;
    }
};

// ------------------------------------------------------------ opening things --
static string url_decode(const string &v) {
    string out;
    for (size_t i = 0; i < v.size(); i++) {
        if (v[i] == '%' && i + 2 < v.size()) {
            auto hex = [](char c) { return c <= '9' ? c - '0' : (tolower(c) - 'a' + 10); };
            out.push_back((char)(hex(v[i + 1]) * 16 + hex(v[i + 2])));
            i += 2;
        } else if (v[i] == '+') {
            out.push_back(' ');
        } else {
            out.push_back(v[i]);
        }
    }
    return out;
}


// a query value runs to the next '&', not to the end of the target
static string query_value(const string &target, const char *key) {
    // a parameter may sit at any position: ?a=1&b=2&c=3
    const string k = string(key) + "=";
    size_t at = 0;
    while ((at = target.find(k, at)) != string::npos) {
        const bool boundary = at > 0 && (target[at - 1] == '?' || target[at - 1] == '&');
        if (boundary) {
            size_t start = at + k.size();
            size_t end = target.find('&', start);
            return url_decode(target.substr(start, end == string::npos ? string::npos : end - start));
        }
        at += k.size();
    }
    return {};
}


static bool open_skin_path(Session &sess, const fs::path &p, string &err);

// Every input, whenever it arrives, ends up here: the first launch calls it
// before the server is up, a later launch reaches it through /api/forward.
static bool apply_inputs(Session &sess, const fs::path &skin,
                         const std::vector<fs::path> &inputs, string &err) {
    if (!skin.empty()) {
        if (!open_skin_path(sess, skin, err)) return false;
        logline("skin    %s", utf8(sess.root.filename().wstring()).c_str());
    } else if (!sess.sources.empty()) {
        // the built in skins are loaded just the same, and say so
        logline("skin    %s (built in)", sess.sources[sess.active].label.c_str());
    }
    for (const auto &in : inputs) {
        if (is_playlist(in)) {
            const size_t before = sess.tracks.size();
            for (auto &t : read_playlist(in)) sess.add(t);
            logline("list    %zu track(s) from %s", sess.tracks.size() - before,
                    utf8(in.filename().wstring()).c_str());
        } else if (fs::is_regular_file(in) && is_audio(in)) {
            sess.add(fs::absolute(in));
            logline("audio   %s", utf8(in.filename().wstring()).c_str());
        } else {
            logline("skip    %s", utf8(in.wstring()).c_str());
        }
    }
    return true;
}

// a folder, a skindef.txt, or a .fbskin package: anything the command line accepts
// add (never replace): opening a second skin keeps the first one available


// the entrypoint is skindef.txt, or skindef.skindef in skins built by the old
// designer; both are searched in the same places
static const char *kDefNames[] = {"skindef.txt", "skindef.skindef"};

static fs::path find_def(const fs::path &dir) {
    std::error_code ec;
    for (const char *name : kDefNames) {
        fs::path p = dir / name;
        if (fs::exists(p, ec)) return p;
    }
    return {};
}

static bool has_def(const std::map<string, string> &pkg) {
    for (const char *name : kDefNames) if (pkg.count(name)) return true;
    return false;
}

// a folder is a skin when its skindef points at layouts that really exist
static bool skin_is_usable(const fs::path &dir) {
    std::error_code ec;
    fs::path def = find_def(dir);
    if (def.empty()) return false;
    string raw = read_file(def);
    std::wstring text;
    for (size_t i = 0; i + 1 < raw.size(); i += 2)
        text.push_back((wchar_t)((unsigned char)raw[i] | ((unsigned char)raw[i + 1] << 8)));
    size_t pos = 0;
    while ((pos = text.find(L"skin:", pos)) != std::wstring::npos) {
        size_t eol = text.find(L'\n', pos);
        std::wstring line = text.substr(pos, eol == std::wstring::npos ? std::wstring::npos : eol - pos);
        // a definition written on Windows ends its lines with CRLF; that \r is not
        // a separator, and treating it as one left the file name empty
        while (!line.empty() && (line.back() == L'\r' || line.back() == L' ' || line.back() == L'\t'))
            line.pop_back();
        size_t sp = line.find_last_of(L" \t");
        if (sp != std::wstring::npos) {
            std::wstring f = line.substr(sp + 1);
            if (f.size() > 4 && fs::exists(dir / fs::path(f), ec)) return true;
        }
        pos = eol == std::wstring::npos ? text.size() : eol;
    }
    return false;
}


// skins exported from the desktop tool wrap everything in one folder
static void strip_common_folder(std::map<string, string> &pkg) {
    if (has_def(pkg)) return;
    string prefix;
    for (auto &kv : pkg) {
        auto slash = kv.first.find('/');
        if (slash == string::npos) return;
        string head = kv.first.substr(0, slash + 1);
        if (prefix.empty()) prefix = head;
        else if (prefix != head) return;
    }
    if (prefix.empty()) return;
    std::map<string, string> flat;
    for (auto &kv : pkg) flat[kv.first.substr(prefix.size())] = std::move(kv.second);
    pkg = std::move(flat);
}

static void remember_skin(Session &sess, const string &label, const fs::path &root,
                          std::map<string, string> files) {
    // the same folder opened twice is the same skin; two different skins that
    // carry the same name (two generations of one skin, say) both stay on offer
    for (size_t i = 0; i < sess.sources.size(); i++) {
        if (sess.sources[i].label != label) continue;
        if (sess.sources[i].root == root) { sess.active = i; return; }
        break;
    }
    auto taken = [&](const string &name) {
        for (const auto &src : sess.sources) if (src.label == name) return true;
        return false;
    };
    string unique = label;
    if (taken(unique)) {
        const string parent = utf8(root.parent_path().filename().wstring());
        unique = label + " (" + parent + ")";
        for (int n = 2; taken(unique); n++)
            unique = label + " (" + parent + " " + std::to_string(n) + ")";
    }
    sess.sources.push_back({unique, root, std::move(files)});
    sess.active = sess.sources.size() - 1;
}

static bool open_skin_path(Session &sess, const fs::path &p, string &err) {
    std::error_code ec;
    if (!fs::exists(p, ec)) { err = "path does not exist"; return false; }
    fs::path root = p;
    std::map<string, string> pkg;
    string name = lower(p.filename().string());
    if (name == "skindef.txt" || name == "skindef.skindef") {
        root = p.parent_path();
    } else if (ext_of(name) == ".fbskin" || ext_of(name) == ".zip") {
        string raw = read_file(p);
        vector<uint8_t> buf(raw.begin(), raw.end());
        vector<ZipEntry> entries;
        vector<string> skipped;
        if (!read_package(buf, entries, skipped) || entries.empty()) {
            err = "cannot read the package";
            return false;
        }
        for (auto &e : entries)
            pkg[lower(e.name)] = string((const char *)e.data.data(), e.data.size());
        strip_common_folder(pkg);
    }
    root = fs::absolute(root, ec);
    string label = utf8(root.filename().wstring());
    remember_skin(sess, label, root, std::move(pkg));
    sess.root = root;
    sess.files = sess.sources[sess.active].files;
    (void)ec;
    return true;
}

static fs::path upload_dir() {
    std::error_code ec;
    fs::path dir = fs::temp_directory_path(ec) / "fb2km-viewer";
    if (dir.empty() || ec) dir = fs::current_path() / ".fb2km-uploads";
    fs::create_directories(dir, ec);
    return dir;
}





static string fields_json(const Media &m, const fs::path &file) {
    std::ostringstream o;
    auto put = [&](const string &k, const string &v) {
        o << "\"" << k << "\":\"" << json_escape(v) << "\",";
    };
    const string ext = lower(file.extension().string());
    const string name = utf8(file.filename().wstring());
    const string stem = utf8(file.stem().wstring());
    const string dir = utf8(file.parent_path().wstring());

    put("title", m.title.empty() ? stem : m.title);
    put("composer", m.composer);
    put("artist", m.artist);
    put("album", m.album);
    put("album artist", m.artist);
    put("date", m.year);
    put("year", m.year.empty() ? "" : m.year.substr(0, 4));
    put("length", m.seconds > 0 ? mmss(m.seconds) : "");
    put("container", m.container);
    put("codec", m.container);
    put("__codec", m.container);
    put("codec_profile", "");
    put("codec_long", m.container);
    put("samplerate", m.rate ? std::to_string(m.rate) : "");
    // [bitrate] carries its unit, which is what the default skins print; the
    // title formatting field stays a bare number, and skins append their own
    put("bitrate", m.bitrate ? std::to_string(m.bitrate) + " kbps" : "");
    put("__bitrate", m.bitrate ? std::to_string(m.bitrate) : "");
    put("bitspersample", m.bits ? std::to_string(m.bits) : "");
    put("__bitspersample", m.bits ? std::to_string(m.bits) : "");
    put("channels", m.channels ? std::to_string(m.channels) : "");
    put("__encoding", m.bits ? "lossless" : "lossy");
    if (m.has_rg) {
        std::ostringstream t, a;
        t << std::fixed << std::setprecision(2) << m.rg_track << " dB";
        a << std::fixed << std::setprecision(2) << m.rg_album << " dB";
        put("replaygain_track_gain", t.str());
        put("replaygain_album_gain", a.str());
    } else {
        put("replaygain_track_gain", "");
        put("replaygain_album_gain", "");
    }
    put("path", utf8(file.wstring()));
    put("_path_raw", "file:///" + utf8(file.wstring()));
    put("filename", stem);
    put("filename_ext", name);
    put("directoryname", utf8(file.parent_path().filename().wstring()));
    put("directory_path", dir);
    put("ext", ext);
    std::error_code ec;
    auto size = fs::file_size(file, ec);
    put("filesize", ec ? "" : std::to_string(size));
    // trailing comma is fine here: the caller wraps the object
    string out = o.str();
    if (!out.empty() && out.back() == ',') out.pop_back();
    return out;
}

static string info_json(Session &s) {
    const Media &m = s.now_meta();
    int pos = s.indexOf(s.playingId);
    int slot = s.playPos();
    bool slotOk = slot >= 0 && slot < (int)s.tracks.size();
    // there is something to play when the slot holds a track, or when a deleted
    // row is still sounding
    bool playable = slotOk || !s.playingPath.empty();
    std::ostringstream o;
    o << "{\"root\":\"" << json_escape(utf8(s.root.wstring())) << "\",";
    o << "\"audio\":" << (playable ? "true" : "false") << ",";
    o << "\"loaded\":" << (s.playingPath.empty() ? "false" : "true") << ",";
    o << "\"playingId\":" << s.playingId << ",\"index\":" << pos
      << ",\"slot\":" << slot << ",\"count\":" << s.tracks.size() << ",";
    o << "\"fields\":{" << fields_json(m, slotOk ? s.tracks[slot].path : fs::path()) << "},";
    o << "\"cover\":" << (m.cover.empty() ? "false" : "true") << ",";
    o << "\"coverUrl\":\"/cover?play=" << s.playingId << "\",";
    o << "\"replaygain\":{\"track\":" << m.rg_track
      << ",\"album\":" << m.rg_album << ",\"present\":"
      << (m.has_rg ? "true" : "false") << "}}";
    return o.str();
}

// tags of any playlist entry, so the page can show the next track
static string peek_json(Session &s, size_t i) {
    if (i >= s.tracks.size()) return "{}";
    const Track &t = s.tracks[i];
    const Media &m = s.meta_of(t.id);
    std::ostringstream o;
    o << "{\"id\":" << t.id << ",\"index\":" << i
      << ",\"label\":\"" << json_escape(utf8(t.path.filename().wstring()))
      << "\",\"title\":\"" << json_escape(m.title) << "\",\"artist\":\"" << json_escape(m.artist)
      << "\",\"album\":\"" << json_escape(m.album)
      << "\",\"fields\":{" << fields_json(m, t.path) << "}}";
    return o.str();
}

// ------------------------------------------------------------------- http --
static string load_file_safe(const std::map<string, string> &mem, const fs::path &root, string rel) {
    // strip query, decode %20, refuse traversal
    auto q = rel.find('?');
    if (q != string::npos) rel = rel.substr(0, q);
    string dec;
    for (size_t i = 0; i < rel.size(); i++) {
        if (rel[i] == '%' && i + 2 < rel.size()) {
            dec += (char)std::stoi(rel.substr(i + 1, 2), nullptr, 16);
            i += 2;
        } else if (rel[i] == '+') dec += ' ';
        else dec += rel[i];
    }
    while (!dec.empty() && dec.front() == '/') dec.erase(dec.begin());
    if (dec.find("..") != string::npos) return {};
    auto it = mem.find(lower(dec));
    if (it != mem.end()) return it->second;
    fs::path p = root / fs::path(wide(dec));
    if (!fs::exists(p) || !fs::is_regular_file(p)) return {};
    return read_file(p);
}

static void send_all(SOCKET s, const string &data) {
    size_t sent = 0;
    while (sent < data.size()) {
        int n = send(s, data.data() + sent, (int)(data.size() - sent), 0);
        if (n <= 0) break;
        sent += (size_t)n;
    }
}

static void respond(SOCKET s, const string &status, const string &type, const string &body,
                    const string &extra = "", bool cacheable = false) {
    std::ostringstream o;
    o << "HTTP/1.1 " << status << "\r\n"
      << "Content-Type: " << type << "\r\n"
      << "Content-Length: " << body.size() << "\r\n"
      << (cacheable ? "Cache-Control: public, max-age=604800\r\n"
                    : "Cache-Control: no-store\r\n")
      << "Connection: close\r\n"
      << extra << "\r\n";
    string head = o.str();
    send_all(s, head);
    send_all(s, body);
}

static void serve_media(SOCKET s, const Session &sess, const string &range) {
    if (sess.playing().empty()) {
        respond(s, "404 Not Found", "text/plain", "no audio");
        return;
    }
    string data = read_file(sess.playing());
    size_t total = data.size();
    size_t start = 0, end = total ? total - 1 : 0;
    bool partial = false;
    if (!range.empty() && range.rfind("bytes=", 0) == 0) {
        auto spec = range.substr(6);
        auto dash = spec.find('-');
        if (dash != string::npos) {
            string a = spec.substr(0, dash), b = spec.substr(dash + 1);
            if (!a.empty()) {
                start = std::stoull(a);
                if (!b.empty())
                    end = std::min<size_t>(std::stoull(b), total ? total - 1 : 0);
            } else if (!b.empty()) {
                // "bytes=-N" means the LAST N bytes, not the first N
                size_t n = std::stoull(b);
                start = n >= total ? 0 : total - n;
                end = total ? total - 1 : 0;
            }
            if (end < start) end = start;
            partial = true;
        }
    }
    if (total == 0) {
        respond(s, "200 OK", "application/octet-stream", string());
        return;
    }
    // a player asking for "the last byte onwards" lands here with start == total;
    // answering 416 makes it treat the whole track as unplayable, so clamp
    if (start >= total) {
        start = total - 1;
        end = total - 1;
        partial = true;
    }
    string body = data.substr(start, end - start + 1);
    std::ostringstream extra;
    if (partial)
        extra << "Content-Range: bytes " << start << "-" << end << "/" << total << "\r\n";
    extra << "Accept-Ranges: bytes\r\n";
    std::cout << "  media range=" << (range.empty() ? "-" : range)
              << " -> " << start << "-" << end << "/" << total
              << (partial ? " 206" : " 200") << std::endl;
    respond(s, partial ? "206 Partial Content" : "200 OK",
            mime_of(sess.playing().filename().string()), body, extra.str());
}

static const char *GLUE = R"JS(
<script>
(async function () {
  let info;
  try { info = await (await fetch('/api/info')).json(); } catch (e) { return; }

  const a = document.createElement('audio');
  a.id = 'audio'; a.controls = true;
  a.style.cssText = 'position:fixed;left:14px;bottom:14px;width:340px;z-index:50';
  document.body.appendChild(a);
  attachAudio(a);

  if (!info.audio) { state.hasAudio = false; render(); return; }
  await applyInfo(info, true);
})();
</script>
)JS";

// Chromium blocks autoplay until the page has been clicked. When the default
// browser is Chromium based we can relax that for this launch.
static std::wstring reg_read(HKEY root, const std::wstring &sub, const wchar_t *name) {
    HKEY key = nullptr;
    std::wstring value;
    if (RegOpenKeyExW(root, sub.c_str(), 0, KEY_QUERY_VALUE, &key) == ERROR_SUCCESS) {
        wchar_t buf[2048];
        DWORD size = sizeof buf, type = 0;
        if (RegQueryValueExW(key, name, nullptr, &type, (BYTE *)buf, &size) == ERROR_SUCCESS &&
            (type == REG_SZ || type == REG_EXPAND_SZ)) {
            value.assign(buf, size / sizeof(wchar_t));
            while (!value.empty() && value.back() == L'\0') value.pop_back();
        }
        RegCloseKey(key);
    }
    return value;
}



// a web page cannot ask for a topmost window; the exe can, once it finds it
static BOOL CALLBACK topmost_cb(HWND h, LPARAM p) {
    wchar_t title[256];
    if (IsWindowVisible(h) && GetWindowTextW(h, title, 256) && wcsstr(title, L"fb2km Skin Viewer")) {
        *(HWND *)p = h;
        return FALSE;
    }
    return TRUE;
}

static void pin_on_top() {
    for (int i = 0; i < 50; i++) {
        HWND found = nullptr;
        EnumWindows(topmost_cb, (LPARAM)&found);
        if (found) {
            SetWindowPos(found, HWND_TOPMOST, 0, 0, 0, 0,
                         SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            printf("window pinned on top\n");
            return;
        }
        Sleep(100);
    }
    printf("could not find the browser window to pin\n");
}

static bool launch_browser(const std::wstring &url) {
    std::wstring progid = reg_read(
        HKEY_CURRENT_USER,
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UrlAssociations\\http\\UserChoice",
        L"ProgId");
    std::wstring command;
    if (!progid.empty())
        command = reg_read(HKEY_CLASSES_ROOT, progid + L"\\shell\\open\\command", nullptr);
    if (command.empty())
        command = reg_read(HKEY_CLASSES_ROOT, L"http\\shell\\open\\command", nullptr);

    std::wstring lower = command;
    for (auto &c : lower) c = (wchar_t)towlower(c);
    bool chromium = lower.find(L"chrome.exe") != std::wstring::npos ||
                    lower.find(L"msedge.exe") != std::wstring::npos;

    auto pos = command.find(L"%1");
    if (pos != std::wstring::npos && chromium) {
        // command looks like: "<exe>" [flags] %1
        auto exeEnd = command.find(L'"', 1);
        std::wstring withFlag = command;
        if (exeEnd != std::wstring::npos) {
            withFlag.insert(exeEnd + 1, L" --autoplay-policy=no-user-gesture-required");
        }
        auto at = withFlag.find(L"%1");
        withFlag.replace(at, 2, L"\"" + url + L"\"");
        STARTUPINFOW si{};
        si.cb = sizeof si;
        PROCESS_INFORMATION pi{};
        std::vector<wchar_t> buf(withFlag.begin(), withFlag.end());
        buf.push_back(0);
        if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            return true;
        }
    }
    return (INT_PTR)ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL) > 32;
}

// Web assets live in the executable's resource section (see page.rc). Each
// entry is one file: adding a script means adding a line here and a line there.
struct WebAsset {
    const char *path;
    const wchar_t *id;
    const char *mime;
};

static const WebAsset WEB_ASSETS[] = {
    {"/",           L"PAGE_HTML", "text/html; charset=utf-8"},
    {"/index.html", L"PAGE_HTML", "text/html; charset=utf-8"},
    {"/app.css",    L"APP_CSS",   "text/css; charset=utf-8"},
    {"/tf.js",      L"TF_JS",     "text/javascript; charset=utf-8"},
    {"/app.js",     L"APP_JS",    "text/javascript; charset=utf-8"},
    {"/fonts/Roboto-Regular.woff2", L"ROBOTO_REGULAR", "font/woff2"},
    {"/fonts/Roboto-Bold.woff2",    L"ROBOTO_BOLD",    "font/woff2"},
    {"/fonts/Roboto-Medium.woff2",     L"ROBOTO_MEDIUM",        "font/woff2"},
    {"/fonts/Roboto-MediumItalic.woff2", L"ROBOTO_MEDIUM_ITALIC", "font/woff2"},
    {"/fonts/Roboto-Italic.woff2",     L"ROBOTO_ITALIC",      "font/woff2"},
    {"/fonts/Roboto-BoldItalic.woff2", L"ROBOTO_BOLD_ITALIC", "font/woff2"},
};

static std::map<std::string, std::string> g_web;
// the two default skins, unpacked from the resources at startup
static std::map<std::string, std::string> g_default_black;
static std::map<std::string, std::string> g_default_white;

static std::string read_resource(const wchar_t *id) {
    HMODULE self = GetModuleHandleW(nullptr);
    HRSRC info = FindResourceW(self, id, MAKEINTRESOURCEW(10));
    if (!info) return {};
    HGLOBAL data = LoadResource(self, info);
    if (!data) return {};
    const char *bytes = (const char *)LockResource(data);
    return std::string(bytes, SizeofResource(self, info));
}

static void load_web_assets() {
    for (const auto &asset : WEB_ASSETS) {
        if (g_web.count(asset.path)) continue;
        std::string body = read_resource(asset.id);
        if (body.empty()) printf("warning: resource %ls missing\n", asset.id);
        g_web[asset.path] = std::move(body);
    }
}

// A cheap fingerprint of the skin folder: newest write time plus total size.
// The page polls it and reloads itself when it changes.
static string skin_fingerprint(const Session &sess) {
    if (!sess.files.empty()) return "package";      // served from memory
    // the built in skins live on no folder at all: walking the working directory
    // would hash an entire project tree once a second
    if (!skin_is_usable(sess.root)) return "package";
    uint64_t newest = 0;
    uint64_t total = 0;
    size_t count = 0;
    std::error_code ec;
    for (auto it = fs::recursive_directory_iterator(sess.root, ec);
         it != fs::recursive_directory_iterator(); it.increment(ec)) {
        if (ec) break;
        if (!it->is_regular_file(ec)) continue;
        string ext = lower(it->path().extension().string());
        if (ext != ".txt" && ext != ".png" && ext != ".jpg") continue;
        auto stamp = it->last_write_time(ec);
        if (ec) continue;
        uint64_t ticks = (uint64_t)stamp.time_since_epoch().count();
        if (ticks > newest) newest = ticks;
        total += (uint64_t)it->file_size(ec);
        count++;
        if (++count > 5000) break;
    }
    std::ostringstream o;
    o << std::hex << newest << "-" << total << "-" << count;
    return o.str();
}

static bool serve_web_asset(SOCKET c, const string &route) {
    for (const auto &asset : WEB_ASSETS) {
        if (route != asset.path) continue;
        auto it = g_web.find(asset.path);
        if (it == g_web.end()) return false;
        respond(c, "200 OK", asset.mime, it->second);
        return true;
    }
    return false;
}

static void handle_client(SOCKET c, Session &sess, std::mutex &mtx) {

    string req;
    char buf[4096];
    while (req.find("\r\n\r\n") == string::npos) {
        int n = recv(c, buf, sizeof buf, 0);
        if (n <= 0) break;
        req.append(buf, n);
        if (req.size() > 65536) break;
    }
    string target = "/", range, body;
    size_t clen = 0;
    {
        auto cp = lower(req).find("\r\ncontent-length:");
        if (cp != string::npos)
            clen = (size_t)std::strtoull(req.c_str() + cp + 17, nullptr, 10);
    }
    {
        auto lineEnd = req.find("\r\n");
        string line = req.substr(0, lineEnd);
        auto s1 = line.find(' ');
        auto s2 = line.find(' ', s1 + 1);
        if (s1 != string::npos && s2 != string::npos) target = line.substr(s1 + 1, s2 - s1 - 1);
        auto rp = lower(req).find("\r\nrange:");
        if (rp != string::npos) {
            auto vs = req.find(':', rp + 2);
            auto ve = req.find("\r\n", vs);
            range = req.substr(vs + 1, ve - vs - 1);
            range.erase(0, range.find_first_not_of(' '));
        }
    }

    if (clen) {
        size_t at = req.find("\r\n\r\n");
        if (at != string::npos) body = req.substr(at + 4);
        while (body.size() < clen) {
            char more[8192];
            int n = recv(c, more, sizeof more, 0);
            if (n <= 0) break;
            body.append(more, n);
        }
        if (body.size() > clen) body.resize(clen);
    }
    if (g_verbose) printf("%s %s (%zu)\n", clen ? "POST" : "GET", target.c_str(), body.size());
    std::unique_lock<std::mutex> guard(mtx);

    // which stream the console last announced: a pause and resume must not repeat
    // it, while opening a track again (which comes through a jump) must
    static int announced = -1;
    string route = target.substr(0, target.find('?'));
    if (serve_web_asset(c, route)) {
        // straight from the resource table
    } else if (route.rfind("/api/list", 0) == 0) {
        std::ostringstream o;
        o << "[";
        for (size_t i = 0; i < sess.tracks.size(); i++) {
            const Track &t = sess.tracks[i];
            const Media &m = sess.meta_of(t.id);      // cached after the first read
            if (i) o << ",";
            o << "{\"id\":" << t.id
              << ",\"name\":\"" << json_escape(utf8(t.path.filename().wstring()))
              << "\",\"title\":\"" << json_escape(m.title)
              << "\",\"artist\":\"" << json_escape(m.artist) << "\"}";
        }
        o << "]";
        respond(c, "200 OK", "application/json; charset=utf-8", o.str());
    } else if (route.rfind("/api/pick", 0) == 0) {
        bool isSkin = target.find("kind=folder") != string::npos;   // a skin folder
        bool isPackage = target.find("kind=package") != string::npos;
        bool isPlaylist = target.find("kind=playlist") != string::npos;
        std::vector<std::wstring> picked;
        guard.unlock();                                  // a modal dialog blocks this thread
        // a playlist replaces the list, so only one of those makes sense; skins
        // and audio accumulate and may be picked several at a time
        bool busy = false;
        // the dialog speaks the system's UI language: it is a system window, and
        // its own buttons follow the same language
        bool chinese = PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE;
        std::wstring tFolder = chinese ? L"选择皮肤目录（含 skindef.txt）" : L"Choose a skin folder (with skindef.txt)";
        std::wstring tPackage = chinese ? L"选择皮肤包" : L"Choose a skin package";
        std::wstring tPlaylist = chinese ? L"选择播放列表" : L"Choose a playlist";
        std::wstring tAudio = chinese ? L"选择音频文件" : L"Choose audio files";
        if (isSkin) picked = pick_paths(true, nullptr, tFolder.c_str(), true, &busy);
        else if (isPackage) picked = pick_paths(false, L"*.fbskin;*.zip", tPackage.c_str(), true, &busy);
        else if (isPlaylist) picked = pick_paths(false, L"*.m3u;*.m3u8", tPlaylist.c_str(), false, &busy);
        else picked = pick_paths(false, L"*.flac;*.mp3;*.m4a;*.aac;*.ogg;*.opus;*.wav;*.wv",
                                tAudio.c_str(), true, &busy);
        guard.lock();
        if (busy) {
            respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":false,\"busy\":true}");
        } else if (picked.empty()) {
            respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":false,\"cancel\":true}");
        } else if (isSkin || isPackage) {
            string err, failed;
            int opened = 0;
            for (const auto &one : picked) {
                if (open_skin_path(sess, fs::path(one), err)) opened++;
                else failed = err;
            }
            if (!opened)
                respond(c, "200 OK", "application/json; charset=utf-8",
                        "{\"ok\":false,\"error\":\"" + json_escape(failed) + "\"}");
            else
                respond(c, "200 OK", "application/json; charset=utf-8",
                        "{\"ok\":true,\"count\":" + std::to_string(opened) + "}");
        } else {
            if (isPlaylist) sess.clear_list();   // keeps a loaded stream sounding
            int added = 0;
            for (const auto &one : picked) {
                fs::path chosen(one);
                if (is_playlist(chosen)) {
                    for (auto &t : read_playlist(chosen)) { sess.add(t); added++; }
                } else if (fs::is_regular_file(chosen)) {
                    sess.add(fs::absolute(chosen));
                    added++;
                }
            }
            respond(c, "200 OK", "application/json; charset=utf-8",
                    "{\"ok\":true,\"added\":" + std::to_string(added) +
                    ",\"count\":" + std::to_string(sess.tracks.size()) + "}");
        }
    } else if (route.rfind("/skin/", 0) == 0) {
        string rest = url_decode(route.substr(6));   // labels may contain spaces
        const SkinSource *hit = nullptr;
        string file;
        for (const auto &src : sess.sources) {
            if (rest.rfind(src.label + "/", 0) != 0) continue;
            if (hit && src.label.size() <= hit->label.size()) continue;
            hit = &src;
            file = rest.substr(src.label.size() + 1);
        }
        if (!hit) {
            respond(c, "404 Not Found", "text/plain", "no such skin");
        } else {
            string body = load_file_safe(hit->files, hit->root, file);
            // a file the skin does not contain is simply missing: the device takes
            // nothing from the built in skin for the elements of a layout
            if (body.empty())
                respond(c, "404 Not Found", "text/plain", "not in this skin");
            else
                respond(c, "200 OK", mime_of(file), body, "", hash_ext(ext_of(file)) != 0);
        }
    } else if (route.rfind("/favicon.ico", 0) == 0) {
        respond(c, "200 OK", "image/x-icon", read_resource(L"APP_ICON"), "", true);
    } else if (route.rfind("/icon.png", 0) == 0) {
        respond(c, "200 OK", "image/png", read_resource(L"APP_ICON_PNG"), "", true);
    } else if (route.rfind("/brand.png", 0) == 0) {
        respond(c, "200 OK", "image/png", read_resource(L"BRAND_PNG"), "", true);
    } else if (route.rfind("/api/log", 0) == 0) {
        const string msg = query_value(target, "msg");
        if (!msg.empty()) logline("%s", msg.c_str());
        respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":true}");
    } else if (route.rfind("/api/forward", 0) == 0) {
        // a later launch reaches this with the paths it was handed, and nothing
        // else; it goes through the same call the first launch uses
        const string skin = query_value(target, "skin");
        const string audio = query_value(target, "audio");
        std::vector<fs::path> inputs;
        size_t at = 0;
        while (!audio.empty() && at <= audio.size()) {
            const size_t nl = audio.find('\n', at);
            const string one = audio.substr(at, nl == string::npos ? string::npos : nl - at);
            if (!one.empty()) inputs.push_back(fs::path(wide(one)));
            if (nl == string::npos) break;
            at = nl + 1;
        }
        string err;
        const bool ok = apply_inputs(sess, skin.empty() ? fs::path() : fs::path(wide(skin)),
                                     inputs, err);
        // the answer names the skin that is now open, so the launcher can put it
        // in the address it opens: ?skin=<name> is what the page reads first
        const string label = sess.sources.empty() ? "" : sess.sources[sess.active].label;
        respond(c, "200 OK", "application/json; charset=utf-8",
                ok ? "{\"ok\":true,\"skin\":\"" + json_escape(label) + "\"}"
                   : "{\"ok\":false,\"error\":\"" + json_escape(err) + "\"}");
    } else if (route.rfind("/api/open-skin", 0) == 0) {
        string path = query_value(target, "path");
        string err;
        logline("open   %s", path.c_str());
        if (!open_skin_path(sess, fs::path(wide(path)), err))
            respond(c, "200 OK", "application/json; charset=utf-8",
                    "{\"ok\":false,\"error\":\"" + json_escape(err) + "\"}");
        else
            respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":true}");
    } else if (route.rfind("/api/upload-skin", 0) == 0) {
        string name = query_value(target, "name");
        if (name.empty()) name = "uploaded.fbskin";
        fs::path dest = upload_dir() / fs::path(name).filename();
        { std::ofstream f(dest, std::ios::binary); f.write(body.data(), (std::streamsize)body.size()); }
        string err;
        logline("skin   %s", utf8(dest.wstring()).c_str());
        if (!open_skin_path(sess, dest, err))
            respond(c, "200 OK", "application/json; charset=utf-8",
                    "{\"ok\":false,\"error\":\"" + json_escape(err) + "\"}");
        else
            respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":true}");
    } else if (route.rfind("/api/move", 0) == 0) {
        auto num = [&](const char *key, size_t def) {
            auto at = target.find(key);
            return at == string::npos ? def : (size_t)std::strtoul(target.c_str() + at + strlen(key), nullptr, 10);
        };
        size_t from = num("from=", 0), to = num("to=", 0);
        if (from < sess.tracks.size() && to < sess.tracks.size() && from != to) {
            Track moved = sess.tracks[from];
            sess.tracks.erase(sess.tracks.begin() + from);
            sess.tracks.insert(sess.tracks.begin() + to, moved);
        }
        respond(c, "200 OK", "application/json; charset=utf-8",
                "{\"ok\":true,\"count\":" + std::to_string(sess.tracks.size()) + "}");
    } else if (route.rfind("/api/remove", 0) == 0) {
        int id = (int)std::strtol(query_value(target, "id").c_str(), nullptr, 10);
        int pos = sess.indexOf(id);
        if (pos >= 0) {
            if (id == sess.playingId) sess.anchor = pos;   // this is where it was
            sess.tracks.erase(sess.tracks.begin() + pos);
        }
        respond(c, "200 OK", "application/json; charset=utf-8",
                "{\"ok\":true,\"count\":" + std::to_string(sess.tracks.size()) + "}");
    } else if (route.rfind("/api/clear-list", 0) == 0) {
        sess.clear_list();
        respond(c, "200 OK", "application/json; charset=utf-8",
                "{\"ok\":true,\"count\":0}");
    } else if (route.rfind("/api/upload-audio", 0) == 0) {
        string name = query_value(target, "name");
        if (name.empty()) name = "uploaded.bin";
        const auto endsWith = [](const string &v, const char *suffix) {
            const size_t n = strlen(suffix);
            return v.size() >= n && _stricmp(v.c_str() + v.size() - n, suffix) == 0;
        };
        const bool isList = endsWith(name, ".m3u") || endsWith(name, ".m3u8");
        logline(isList ? "list   %s" : "audio  %s", name.c_str());
        if (body.empty()) {
            respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"empty upload\"}");
            shutdown(c, SD_SEND);
            closesocket(c);
            return;
        }
        bool replace = target.find("mode=replace") != string::npos || target.find("first=1") != string::npos;
        if (replace) sess.clear_list();   // keeps a loaded stream sounding
        bool insert = target.find("mode=insert") != string::npos;
        int at = (int)std::strtol(query_value(target, "at").c_str(), nullptr, 10);
        fs::path dest = upload_dir() / fs::path(name).filename();
        { std::ofstream f(dest, std::ios::binary); f.write(body.data(), (std::streamsize)body.size()); }
        if (is_playlist(dest)) {
            for (auto &t : read_playlist(dest)) sess.add(t);
        } else if (insert) {
            sess.insert(fs::absolute(dest), at);
        } else {
            sess.add(fs::absolute(dest));
        }
        respond(c, "200 OK", "application/json; charset=utf-8",
                "{\"ok\":true,\"count\":" + std::to_string(sess.tracks.size()) + "}");
    } else if (route.rfind("/api/skins", 0) == 0) {
        // a skin is identified by its skindef.txt, so opening a folder after one
        // of its subskins only contributes the ones still missing
        std::set<string> seen;
        std::ostringstream list;
        list << "[";
        bool firstEntry = true;
        auto addLabel = [&](const string &label) {
            if (!firstEntry) list << ",";
            firstEntry = false;
            list << "\"" << json_escape(label) << "\"";
        };
        std::error_code ec;
        auto claim = [&](const fs::path &dir, bool package, const string &label, const string &sub) -> bool {
            string key = package ? "pkg:" + label
                                 : utf8(fs::weakly_canonical(find_def(dir), ec).wstring());
            if (!seen.insert(key).second) return false;      // already offered
            addLabel(sub.empty() ? label : label + "/" + sub);
            return true;
        };
        for (const auto &src : sess.sources) {
            if (src.label.empty()) continue;
            if (!src.files.empty()) { claim(src.root, true, src.label, ""); continue; }
            if (skin_is_usable(src.root)) { claim(src.root, false, src.label, ""); continue; }
            // a folder of skins: walk a few levels down, so opening the parent of
            // a skin folder still finds the skins inside it
            std::function<void(const fs::path &, int)> walk = [&](const fs::path &dir, int depth) {
                for (auto it = fs::directory_iterator(dir, ec);
                     !ec && it != fs::directory_iterator(); it.increment(ec)) {
                    if (!it->is_directory()) continue;
                    // scratch and metadata folders are not skins to offer
                    if (it->path().filename().wstring().rfind(L".", 0) == 0) continue;
                    if (skin_is_usable(it->path())) {
                        string rel = utf8(fs::relative(it->path(), src.root, ec).generic_wstring());
                        claim(it->path(), false, src.label, rel);
                    } else if (depth < 3) {
                        walk(it->path(), depth + 1);
                    }
                }
            };
            walk(src.root, 1);
        }
        list << "]";
        respond(c, "200 OK", "application/json; charset=utf-8", list.str());
    } else if (route.rfind("/skin/", 0) == 0) {
        string rest = url_decode(route.substr(6));   // labels may contain spaces
        const SkinSource *hit = nullptr;
        string file;
        for (const auto &src : sess.sources) {
            if (rest.rfind(src.label + "/", 0) != 0) continue;
            if (hit && src.label.size() <= hit->label.size()) continue;
            hit = &src;
            file = rest.substr(src.label.size() + 1);
        }
        if (!hit) {
            respond(c, "404 Not Found", "text/plain", "no such skin");
        } else {
            string body = load_file_safe(hit->files, hit->root, file);
            // a file the skin does not contain is simply missing: the device takes
            // nothing from the built in skin for the elements of a layout
            if (body.empty())
                respond(c, "404 Not Found", "text/plain", "not in this skin");
            else
                respond(c, "200 OK", mime_of(file), body, "", hash_ext(ext_of(file)) != 0);
        }
    } else if (route.rfind("/favicon.ico", 0) == 0) {
        respond(c, "200 OK", "image/x-icon", read_resource(L"APP_ICON"), "", true);
    } else if (route.rfind("/icon.png", 0) == 0) {
        respond(c, "200 OK", "image/png", read_resource(L"APP_ICON_PNG"), "", true);
    } else if (route.rfind("/brand.png", 0) == 0) {
        respond(c, "200 OK", "image/png", read_resource(L"BRAND_PNG"), "", true);
    } else if (route.rfind("/api/open-skin", 0) == 0) {
        string path = query_value(target, "path");
        string err;
        if (!open_skin_path(sess, fs::path(wide(path)), err))
            respond(c, "200 OK", "application/json; charset=utf-8",
                    "{\"ok\":false,\"error\":\"" + json_escape(err) + "\"}");
        else
            respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":true}");
    } else if (route.rfind("/api/upload-skin", 0) == 0) {
        string name = query_value(target, "name");
        if (name.empty()) name = "uploaded.fbskin";
        fs::path dest = upload_dir() / fs::path(name).filename();
        { std::ofstream f(dest, std::ios::binary); f.write(body.data(), (std::streamsize)body.size()); }
        string err;
        if (!open_skin_path(sess, dest, err))
            respond(c, "200 OK", "application/json; charset=utf-8",
                    "{\"ok\":false,\"error\":\"" + json_escape(err) + "\"}");
        else
            respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":true}");
    } else if (route.rfind("/api/move", 0) == 0) {
        auto num = [&](const char *key, size_t def) {
            auto at = target.find(key);
            return at == string::npos ? def : (size_t)std::strtoul(target.c_str() + at + strlen(key), nullptr, 10);
        };
        size_t from = num("from=", 0), to = num("to=", 0);
        if (from < sess.tracks.size() && to < sess.tracks.size() && from != to) {
            Track moved = sess.tracks[from];
            sess.tracks.erase(sess.tracks.begin() + from);
            sess.tracks.insert(sess.tracks.begin() + to, moved);
        }
        respond(c, "200 OK", "application/json; charset=utf-8",
                "{\"ok\":true,\"count\":" + std::to_string(sess.tracks.size()) + "}");
    } else if (route.rfind("/api/remove", 0) == 0) {
        int id = (int)std::strtol(query_value(target, "id").c_str(), nullptr, 10);
        int pos = sess.indexOf(id);
        if (pos >= 0) {
            if (id == sess.playingId) sess.anchor = pos;   // this is where it was
            sess.tracks.erase(sess.tracks.begin() + pos);
        }
        respond(c, "200 OK", "application/json; charset=utf-8",
                "{\"ok\":true,\"count\":" + std::to_string(sess.tracks.size()) + "}");
    } else if (route.rfind("/api/clear-list", 0) == 0) {
        sess.clear_list();
        respond(c, "200 OK", "application/json; charset=utf-8",
                "{\"ok\":true,\"count\":0}");
    } else if (route.rfind("/api/upload-audio", 0) == 0) {
        string name = query_value(target, "name");
        if (name.empty()) name = "uploaded.bin";
        if (body.empty()) {
            respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"empty upload\"}");
            shutdown(c, SD_SEND);
            closesocket(c);
            return;
        }
        bool replace = target.find("mode=replace") != string::npos || target.find("first=1") != string::npos;
        if (replace) sess.clear_list();   // keeps a loaded stream sounding
        bool insert = target.find("mode=insert") != string::npos;
        int at = (int)std::strtol(query_value(target, "at").c_str(), nullptr, 10);
        fs::path dest = upload_dir() / fs::path(name).filename();
        { std::ofstream f(dest, std::ios::binary); f.write(body.data(), (std::streamsize)body.size()); }
        if (is_playlist(dest)) {
            for (auto &t : read_playlist(dest)) sess.add(t);
        } else if (insert) {
            sess.insert(fs::absolute(dest), at);
        } else {
            sess.add(fs::absolute(dest));
        }
        respond(c, "200 OK", "application/json; charset=utf-8",
                "{\"ok\":true,\"count\":" + std::to_string(sess.tracks.size()) + "}");
    } else if (route.rfind("/api/settings", 0) == 0) {
        respond(c, "200 OK", "application/json; charset=utf-8", settings_json());
    } else if (route.rfind("/api/version", 0) == 0) {
        string root = utf8(sess.root.filename().wstring());
        respond(c, "200 OK", "application/json; charset=utf-8",
                "{\"app\":\"fbsv\",\"v\":\"" + json_escape(skin_fingerprint(sess)) +
                "\",\"root\":\"" + json_escape(root) + "\"}");
    } else if (route.rfind("/api/info", 0) == 0) {
        sess.resolve();
        respond(c, "200 OK", "application/json; charset=utf-8", info_json(sess));
    } else if (route.rfind("/cover", 0) == 0 && !sess.empty()) {
        int want = sess.playingId;
        int byId = (int)std::strtol(query_value(target, "play").c_str(), nullptr, 10);
        if (byId > 0) want = byId;
        const Media &cm = sess.meta_of(want);
        // a track's artwork never changes, so it can be cached like the skin
        if (!cm.cover.empty()) {
            const std::string &small = sess.thumb_of(want);
            if (!small.empty())
                respond(c, "200 OK", "image/jpeg", small, "", true);
            else
                respond(c, "200 OK", cm.cover_mime.empty() ? "image/jpeg" : cm.cover_mime,
                        string((const char *)cm.cover.data(), cm.cover.size()), "", true);
        }
        else respond(c, "404 Not Found", "text/plain", "no cover");
    } else if (route.rfind("/api/jump", 0) == 0) {
        int want = (int)std::strtol(query_value(target, "id").c_str(), nullptr, 10);
        int pos = sess.indexOf(want);
        if (pos >= 0) {
            sess.playingId = want;
            sess.playingPath = sess.tracks[pos].path;
            announced = -1;             // a new stream: let its start line through
        }
        respond(c, "200 OK", "application/json; charset=utf-8", info_json(sess));
    } else if (route.rfind("/api/started", 0) == 0) {
        // the page tells us playback really began; that, not a byte request, is
        // what makes a row "the one being heard"
        int want = (int)std::strtol(query_value(target, "id").c_str(), nullptr, 10);
        int pos = sess.indexOf(want);
        if (pos >= 0) { sess.playingId = want; sess.playingPath = sess.tracks[pos].path; }
        // one line per stream: resuming the same track is not a new one
        if (pos >= 0 && want != announced) {
            announced = want;
            logline("play   %s (%d/%d)", utf8(sess.tracks[pos].path.filename().wstring()).c_str(),
                    pos + 1, (int)sess.tracks.size());
        }
        respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":true}");
    } else if (route.rfind("/api/stop", 0) == 0) {
        logline("stop");
        announced = -1;                 // playing it again opens a new stream
        sess.playingPath.clear();      // the file is released; the list decides next
        sess.resolve();
        respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":true}");
    } else if (route.rfind("/api/peek", 0) == 0) {
        int byId = (int)std::strtol(query_value(target, "id").c_str(), nullptr, 10);
        int pos = sess.indexOf(byId);
        respond(c, "200 OK", "application/json; charset=utf-8",
                peek_json(sess, pos < 0 ? 0 : (size_t)pos));
    } else if (route.rfind("/media", 0) == 0 && !sess.empty()) {
        sess.resolve();
        serve_media(c, sess, range);
    } else {
        string body = load_file_safe(sess.files, sess.root, target);
        if (body.empty()) {
            printf("  404 %s\n", target.c_str());
            respond(c, "404 Not Found", "text/plain", "not found");
        }
        else {
            // skin images carry a fingerprint in the query string, so a long
            // cache is safe and stops the buttons blanking when they swap art
            switch (hash_ext(ext_of(target))) {
                case 1: case 2: case 3: case 4: case 5:
                    respond(c, "200 OK", mime_of(target), body, "", true);
                    break;
                default:
                    respond(c, "200 OK", mime_of(target), body);
                    break;
            }
        }
    }
shutdown(c, SD_SEND);
closesocket(c);
}



static std::map<string, string> unpack_resource(const wchar_t *id) {
    std::map<string, string> out;
    string raw = read_resource(id);
    if (raw.empty()) return out;
    vector<uint8_t> buf(raw.begin(), raw.end());
    vector<ZipEntry> entries;
    vector<string> skipped;
    if (!read_package(buf, entries, skipped)) return out;
    for (auto &e : entries)
        out[lower(e.name)] = string((const char *)e.data.data(), e.data.size());
    return out;
}

// the format says a missing image comes from the black or the white default skin
static void load_default_skins() {
    g_default_black = unpack_resource(L"DEFAULT_BLACK");
    g_default_white = unpack_resource(L"DEFAULT_WHITE");

}


// ------------------------------------------------------------------- assoc --
// A per-user "open with" entry for .fbskin. It never touches the user's default
// choice, which Windows protects: the association only makes fbsv show up in the
// Open with list, where the user picks it once.
static bool regWrite(const wchar_t *sub, const wchar_t *name, const wchar_t *value) {
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, sub, 0, nullptr, 0, KEY_WRITE, nullptr, &key, nullptr)
        != ERROR_SUCCESS) {
        return false;
    }
    const DWORD bytes = (DWORD)((wcslen(value) + 1) * sizeof(wchar_t));
    const bool ok = RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE *>(value), bytes)
                    == ERROR_SUCCESS;
    RegCloseKey(key);
    return ok;
}

static void regDrop(const wchar_t *sub) {
    RegDeleteTreeW(HKEY_CURRENT_USER, sub);
}


static bool handleAssociation(bool install) {
    wchar_t exe[MAX_PATH] = {};
    if (!GetModuleFileNameW(nullptr, exe, MAX_PATH)) return false;
    std::wstring cmd = L"\"";
    cmd += exe;
    cmd += L"\" \"%1\"";

    if (install) {
        regWrite(L"Software\\Classes\\.fbskin", nullptr, L"fbsv.skin");
        regWrite(L"Software\\Classes\\.fbskin\\OpenWithProgids", L"fbsv.skin", L"");
        regWrite(L"Software\\Classes\\fbsv.skin", nullptr, L"foobar2000 mobile skin");
        regWrite(L"Software\\Classes\\Applications\\fbsv.exe", L"FriendlyAppName",
                 L"foobar2000 mobile Skin Viewer");
        regWrite(L"Software\\Classes\\fbsv.skin\\DefaultIcon", nullptr,
                 (std::wstring(L"\"") + exe + L"\",-2").c_str());   // -2: resource id 2
        regWrite(L"Software\\Classes\\fbsv.skin\\shell\\open\\command", nullptr, cmd.c_str());
        regWrite(L"Software\\Classes\\Applications\\fbsv.exe\\SupportedTypes", L".fbskin", L"");
        regWrite(L"Software\\Classes\\Applications\\fbsv.exe\\shell\\open\\command", nullptr, cmd.c_str());
        printf("registered .fbskin for the current user\n");
        printf("pick it once: right click a .fbskin -> Open with -> Choose another app\n");
        return true;
    }

    // only take away what is still ours
    wchar_t cur[64] = {};
    DWORD size = sizeof(cur), type = 0;
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Classes\\.fbskin", 0, KEY_READ, &key)
        == ERROR_SUCCESS) {
        RegQueryValueExW(key, nullptr, nullptr, &type, reinterpret_cast<LPBYTE>(cur), &size);
        RegCloseKey(key);
    }
    if (wcscmp(cur, L"fbsv.skin") == 0) regDrop(L"Software\\Classes\\.fbskin");
    else regDrop(L"Software\\Classes\\.fbskin\\OpenWithProgids");
    regDrop(L"Software\\Classes\\fbsv.skin");
    regDrop(L"Software\\Classes\\Applications\\fbsv.exe");
    printf("removed the .fbskin association\n");
    return true;
}


int main() {
    SetConsoleOutputCP(CP_UTF8);
    enableVt();

    // needed before anything probes for a running instance
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        printf("winsock failed\n");
        return 1;
    }
    load_config();               // fbsv.ini next to the exe, if there is one
    load_default_skins();        // needed before the skin argument is resolved
    setvbuf(stdout, nullptr, _IONBF, 0);   // the title line is wanted immediately

    // unicode-safe arguments (paths with CJK characters are common here)
    int argc = 0;
    LPWSTR *argvw = CommandLineToArgvW(GetCommandLineW(), &argc);


    fs::path skinArg;
    bool openBrowser = g_cfg.open;
    bool debugUrl = g_cfg.debug;
    bool singleInstance = g_cfg.single;
    bool pinTop = g_cfg.top;
    bool forceNew = false;
    bool portGiven = g_cfg.port != 0;
    int explicitPort = g_cfg.port;
    if (g_cfg.debug) g_verbose = true;
    std::vector<fs::path> args;
    fs::path skinFlag;                       // --skin beats the sniffing
    std::vector<fs::path> audioFlag, listFlag;
    string uiDev = g_cfg.dev, uiSt = g_cfg.st, uiBar = g_cfg.bar;   // the view half
    string uiLang = g_cfg.lang, uiTheme = g_cfg.theme, uiLayout;    // config first
    bool literal = false;                    // after --, nothing is a switch
    int i = 1;                               // the loop index, shared with the lambdas

    auto value = [&](const wchar_t *name) -> std::wstring {
        if (i + 1 >= argc) {
            fprintf(stderr, "%s needs a value\n", utf8(std::wstring(name)).c_str());
            std::exit(2);
        }
        return argvw[++i];
    };
    auto wrongValue = [&](const char *what, const std::wstring &got) -> int {
        fprintf(stderr, "%s: %s\n", what, utf8(got).c_str());
        fprintf(stderr, "try fbsv --help\n");
        return 2;
    };
    // the address is written in one fixed order, whatever order the flags came in
    auto buildView = [&]() {
        string out;
        auto add = [&](const char *key, const string &v) {
            if (v.empty()) return;
            if (!out.empty()) out += "&";
            out += key;
            out += "=";
            out += v;
        };
        add("layout", uiLayout);
        add("dev", uiDev);
        add("st", uiSt);
        add("bar", uiBar);
        add("lang", uiLang);
        add("theme", uiTheme);
        return out;
    };

    for (; i < argc; i++) {
        std::wstring arg = argvw[i];
        if (literal) { args.push_back(fs::path(arg)); continue; }
        if (arg == L"--") { literal = true; continue; }
        if (arg == L"-h" || arg == L"--help" || arg == L"-?") { usage(); return 0; }
        if (arg == L"-V" || arg == L"--version") { printf("%s %s\n", kProduct, kVersion); return 0; }
        if (arg == L"--no-open") { openBrowser = false; continue; }
        if (arg == L"--debug") { debugUrl = true; g_verbose = true; continue; }
        if (arg == L"--single") { singleInstance = true; continue; }
        if (arg == L"--top") { pinTop = true; continue; }
        if (arg == L"--new") { forceNew = true; continue; }
        if (arg == L"--port") { explicitPort = _wtoi(value(L"--port").c_str()); portGiven = true; continue; }
        if (arg == L"--register") { handleAssociation(true); return 0; }
        if (arg == L"--unregister") { handleAssociation(false); return 0; }

        // the view flags: they only ever become the query of the address
        if (arg == L"-s" || arg == L"--skin") { skinFlag = fs::path(value(L"--skin")); continue; }
        if (arg == L"-a" || arg == L"--audio") { audioFlag.push_back(fs::path(value(L"--audio"))); continue; }
        if (arg == L"-l" || arg == L"--list") { listFlag.push_back(fs::path(value(L"--list"))); continue; }
        if (arg == L"--dev") {
            const std::wstring v = value(L"--dev");
            const bool autoDev = v == L"auto";
            const bool size = std::regex_match(v, std::wregex(L"[0-9]+x[0-9]+"));
            if (!autoDev && !size) return wrongValue("--dev wants auto or WxH", v);
            uiDev = utf8(v);
            continue;
        }
        if (arg == L"--st" || arg == L"--status-h") {
            const std::wstring v = value(L"--st");
            const bool autoSt = v == L"auto";
            const bool number = std::regex_match(v, std::wregex(L"[0-9]+"));
            if (!autoSt && !number) return wrongValue("--st wants auto or a number", v);
            uiSt = utf8(v);
            continue;
        }
        if (arg == L"--bar") {
            const std::wstring v = value(L"--bar");
            if (v != L"0" && v != L"1") return wrongValue("--bar wants 0 or 1", v);
            uiBar = utf8(v);
            continue;
        }
        if (arg == L"--theme") {
            const std::wstring v = value(L"--theme");
            if (v != L"auto" && v != L"dark" && v != L"light") return wrongValue("--theme wants auto, dark or light", v);
            uiTheme = utf8(v);
            continue;
        }
        if (arg == L"--lang") {
            const std::wstring v = value(L"--lang");
            if (v != L"zh" && v != L"en") return wrongValue("--lang wants zh or en", v);
            uiLang = utf8(v);
            continue;
        }
        if (arg == L"--layout") { uiLayout = query_escape(utf8(value(L"--layout"))); continue; }

        if (!arg.empty() && arg[0] == L'-') {
            fprintf(stderr, "unknown option: %s\n", utf8(arg).c_str());
            fprintf(stderr, "try fbsv --help\n");
            return 2;
        }
        args.push_back(fs::path(arg));
    }
    const string uiQuery = buildView();
    if (argvw) LocalFree(argvw);

    // instances are independent (each binds its own port); --single restores the
    // old "only one at a time" behaviour when that is wanted
    HANDLE single = nullptr;
    if (singleInstance) {
        single = CreateMutexW(nullptr, TRUE, L"Local\\fb2km-skin-viewer");
        if (single && GetLastError() == ERROR_ALREADY_EXISTS) {
            printf("another fbsv is already running - close it first\n");
            return 2;
        }
    }

    // the first argument may be the skin; anything else is music. --skin says so
    // outright, and then every positional is music
    std::vector<fs::path> inputs;
    if (!skinFlag.empty()) {
        skinArg = skinFlag;
        inputs = args;
    } else if (!args.empty()) {
        const fs::path &first = args.front();
        bool looksLikeSkin = fs::is_directory(first) || is_playlist_ext(first) == false &&
                             (ext_of(first.filename().string()) == ".fbskin" ||
                              ext_of(first.filename().string()) == ".zip" ||
                              (lower(first.filename().string()) == "skindef.txt" ||
             lower(first.filename().string()) == "skindef.skindef")) ||
                             fs::is_directory(first);
        if (fs::is_directory(first) || ext_of(first.filename().string()) == ".fbskin" ||
            ext_of(first.filename().string()) == ".zip" ||
            lower(first.filename().string()) == "skindef.txt" ||
            lower(first.filename().string()) == "skindef.skindef") {
            skinArg = first;
            inputs.assign(args.begin() + 1, args.end());
        } else {
            inputs = args;
        }
        (void)looksLikeSkin;
    }
    // an explicitly named track goes ahead of whatever the positionals were, and
    // --list keeps a playlist from being mistaken for a song
    inputs.insert(inputs.begin(), listFlag.begin(), listFlag.end());
    inputs.insert(inputs.begin(), audioFlag.begin(), audioFlag.end());

    // A later launch hands its arguments to the instance that is already serving,
    // so dragging a package onto the exe replaces the skin in the open window
    // instead of filling the machine with servers. --new keeps the old behaviour.
    if (!forceNew) {
        std::vector<Instance> alive;
        const auto known = read_instances();
        for (const auto &in : known) if (pid_alive(in.pid) && is_ours(in.port)) alive.push_back(in);
        if (alive.size() != known.size()) write_instances(alive);
        if (!alive.empty()) {
            Instance target = alive.front();
            for (const auto &in : alive) if (in.port == kBasePort) { target = in; break; }
            string query;
            if (!skinArg.empty()) query += "&skin=" + query_escape(utf8(skinArg.wstring()));
            string joined;
            for (const auto &p : inputs) joined += utf8(p.wstring()) + "\n";
            if (!joined.empty()) query += "&audio=" + query_escape(joined);
            const string answer = http_call(target.port, "POST", "/api/forward?" + query);
            if (answer.find("\"ok\":true") != string::npos) {
                // the address names the skin that was just opened, so the new tab
                // shows it without having to guess
                string open = uiQuery;
                const size_t at = answer.find("\"skin\":\"");
                if (at != string::npos) {
                    const size_t from = at + 8;
                    const size_t to = answer.find('"', from);
                    if (to != string::npos) {
                        const string name = answer.substr(from, to - from);
                        if (!name.empty()) open = "skin=" + query_escape(name) +
                                                   (open.empty() ? "" : "&" + open);
                    }
                }
                const string url = "http://127.0.0.1:" + std::to_string(target.port) + "/" +
                                   (open.empty() ? "" : "?" + open);
                printf("handed to the instance on port %d\n", target.port);
                printf("  open %s\n", url.c_str());
                if (openBrowser) launch_browser(wide(url));
                return 0;
            }
        }
    }


    Session sess;
    sess.root = fs::absolute(fs::current_path());
    if (skinArg.empty()) {
        // nothing was opened: both built in skins are offered, and the white one
        // is what the app itself starts with
        remember_skin(sess, "White Skin", sess.root, g_default_white);
        remember_skin(sess, "Black Skin", sess.root, g_default_black);
        sess.active = 0;
        sess.files = sess.sources[0].files;   // the active package, served from memory
    }

    if (!sess.files.empty() && !skinArg.empty()) sess.root = fs::absolute(skinArg);
    // a list that arrives with the process starts on its first entry: selected
    // right away, and played if the browser allows it
    if (!sess.tracks.empty()) sess.playingId = sess.tracks.front().id;

    // the port is stable so a bookmark keeps working; busy ports are skipped and
    // the next free one is taken, an ephemeral port only when the range is full
    auto tryBind = [](int want, int &got) -> SOCKET {
        SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (s == INVALID_SOCKET) return INVALID_SOCKET;
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = inet_addr("127.0.0.1");
        a.sin_port = htons((u_short)want);
        if (bind(s, (sockaddr *)&a, sizeof a) != 0 || listen(s, 16) != 0) {
            closesocket(s);
            return INVALID_SOCKET;
        }
        int len = sizeof a;
        getsockname(s, (sockaddr *)&a, &len);
        got = ntohs(a.sin_port);
        return s;
    };

    int port = 0;
    SOCKET srv = INVALID_SOCKET;
    if (portGiven) {
        srv = tryBind(explicitPort, port);
        if (srv == INVALID_SOCKET) {
            printf("port %d is not free\n", explicitPort);
            return 1;
        }
    } else {
        for (int p = kBasePort; p < kBasePort + 100 && srv == INVALID_SOCKET; p++) srv = tryBind(p, port);
        if (srv == INVALID_SOCKET) srv = tryBind(0, port);
        if (srv == INVALID_SOCKET) {
            printf("cannot listen\n");
            return 1;
        }
    }
    {
        // the registry is what a later launch looks at; guard the read-modify-write
        HANDLE lock = CreateMutexW(nullptr, FALSE, L"Local\\fb2km-skin-viewer-instances");
        if (lock) WaitForSingleObject(lock, 2000);
        auto list = read_instances();
        list.erase(std::remove_if(list.begin(), list.end(),
                                  [](const Instance &i) { return i.pid == GetCurrentProcessId(); }),
                   list.end());
        list.push_back({(int)GetCurrentProcessId(), port});
        write_instances(list);
        if (lock) { ReleaseMutex(lock); CloseHandle(lock); }
    }
    {
        // several instances may run side by side; the port tells them apart
        wchar_t title[96];
        swprintf(title, 96, L"fbsv:%d", port);
        SetConsoleTitleW(title);
    }
    string viewQuery = uiQuery;
    if (debugUrl) viewQuery = viewQuery.empty() ? "debug" : "debug&" + viewQuery;
    string url = "http://127.0.0.1:" + std::to_string(port) + "/" +
                 (viewQuery.empty() ? "" : "?" + viewQuery);

    printf("\n%s %s\n\n", kProduct, kVersion);
    printf("  %-9s %s\n", "listening", link(url, url).c_str());
    if (g_cfg.loaded) printf("  %-9s %s\n", "config", g_cfg.path.c_str());
    printf("  %-9s %s\n", "opens", "a .fbskin dropped here or double-clicked, a skin folder, audio");
    printf("  %-9s %s\n", "stops", "closing this window");
    printf("\n");

    // the inputs are applied once the banner is out, so the events read in order;
    // the very same call a later launch reaches through /api/forward
    string inputErr;
    if (!apply_inputs(sess, skinArg, inputs, inputErr)) {
        printf("cannot open %s: %s\n", utf8(skinArg.wstring()).c_str(), inputErr.c_str());
        return 1;
    }
    // a list that arrives with the process starts on its first entry: selected
    // right away, and played if the browser allows it
    if (!sess.tracks.empty()) sess.playingId = sess.tracks.front().id;
    fflush(stdout);
    if (pinTop) std::thread(pin_on_top).detach();
    if (openBrowser) {
        if (!launch_browser(wide(url)))
            printf("could not start a browser, open the address above manually\n");
    }

    load_web_assets();
    std::mutex mtx;
    for (;;) {
        SOCKET c = accept(srv, nullptr, nullptr);
        if (c == INVALID_SOCKET) break;
        std::thread(handle_client, c, std::ref(sess), std::ref(mtx)).detach();
    }

    WSACleanup();
    return 0;
}
