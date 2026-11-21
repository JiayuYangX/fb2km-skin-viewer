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

#pragma comment(lib, "ws2_32.lib")

namespace fs = std::filesystem;
using std::string;
using std::vector;

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
            size_t usize = u32(p + 24);
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
    std::map<int, Media> cache;       // tags by track id

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

// a folder, a skindef.txt, or a .fbskin package: anything the command line accepts
// add (never replace): opening a second skin keeps the first one available

// a folder is a skin when its skindef points at layouts that really exist
static bool skin_is_usable(const fs::path &dir) {
    std::error_code ec;
    fs::path def = dir / "skindef.txt";
    if (!fs::exists(def, ec)) return false;
    string raw = read_file(def);
    std::wstring text;
    for (size_t i = 0; i + 1 < raw.size(); i += 2)
        text.push_back((wchar_t)((unsigned char)raw[i] | ((unsigned char)raw[i + 1] << 8)));
    size_t pos = 0;
    while ((pos = text.find(L"skin:", pos)) != std::wstring::npos) {
        size_t eol = text.find(L'\n', pos);
        std::wstring line = text.substr(pos, eol == std::wstring::npos ? std::wstring::npos : eol - pos);
        size_t sp = line.find_last_of(L" \t\r");
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
    if (pkg.count("skindef.txt")) return;
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
    for (size_t i = 0; i < sess.sources.size(); i++) {
        if (sess.sources[i].label == label) { sess.active = i; return; }
    }
    sess.sources.push_back({label, root, std::move(files)});
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
        if (!read_zip(buf, entries, skipped) || entries.empty()) {
            err = "cannot read the package";
            return false;
        }
        for (auto &e : entries)
            pkg[lower(e.name)] = string((const char *)e.data.data(), e.data.size());
        strip_common_folder(pkg);
    }
    root = fs::absolute(root, ec);
    string label = name == "skindef.txt" ? utf8(root.filename().wstring()) : utf8(root.filename().wstring());
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
    put("bitrate", m.bitrate ? std::to_string(m.bitrate) : "");
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
    printf("%s %s (%zu)\n", clen ? "POST" : "GET", target.c_str(), body.size());
    std::unique_lock<std::mutex> guard(mtx);

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
            if (body.empty()) {
                bool image = hash_ext(ext_of(file)) != 0;
                // a picture the skin lacks comes from the built in defaults
                const auto &pkg = hash_ext(ext_of(file)) ? g_default_black : g_default_black;
                auto alt = pkg.find(lower(file));
                if (image && alt != pkg.end())
                    respond(c, "200 OK", mime_of(file), alt->second, "", true);
                else
                    respond(c, "404 Not Found", "text/plain", "not in this skin");
            } else {
                respond(c, "200 OK", mime_of(file), body, "", hash_ext(ext_of(file)) != 0);
            }
        }
    } else if (route.rfind("/favicon.ico", 0) == 0) {
        respond(c, "200 OK", "image/x-icon", read_resource(L"APP_ICON"), "", true);
    } else if (route.rfind("/icon.png", 0) == 0) {
        respond(c, "200 OK", "image/png", read_resource(L"APP_ICON_PNG"), "", true);
    } else if (route.rfind("/brand.png", 0) == 0) {
        respond(c, "200 OK", "image/png", read_resource(L"BRAND_PNG"), "", true);
    } else if (route.rfind("/default/", 0) == 0) {
        bool white = route.rfind("/default/white/", 0) == 0;
        string file = lower(route.substr(15));
        const auto &pkg = white ? g_default_white : g_default_black;
        auto it = pkg.find(file);
        if (it == pkg.end()) respond(c, "404 Not Found", "text/plain", "not in the default skin");
        else respond(c, "200 OK", mime_of(file), it->second, "", hash_ext(ext_of(file)) != 0);
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
                                 : utf8(fs::weakly_canonical(dir / "skindef.txt", ec).wstring());
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
            if (body.empty()) {
                bool image = hash_ext(ext_of(file)) != 0;
                // a picture the skin lacks comes from the built in defaults
                const auto &pkg = hash_ext(ext_of(file)) ? g_default_black : g_default_black;
                auto alt = pkg.find(lower(file));
                if (image && alt != pkg.end())
                    respond(c, "200 OK", mime_of(file), alt->second, "", true);
                else
                    respond(c, "404 Not Found", "text/plain", "not in this skin");
            } else {
                respond(c, "200 OK", mime_of(file), body, "", hash_ext(ext_of(file)) != 0);
            }
        }
    } else if (route.rfind("/favicon.ico", 0) == 0) {
        respond(c, "200 OK", "image/x-icon", read_resource(L"APP_ICON"), "", true);
    } else if (route.rfind("/icon.png", 0) == 0) {
        respond(c, "200 OK", "image/png", read_resource(L"APP_ICON_PNG"), "", true);
    } else if (route.rfind("/brand.png", 0) == 0) {
        respond(c, "200 OK", "image/png", read_resource(L"BRAND_PNG"), "", true);
    } else if (route.rfind("/default/", 0) == 0) {
        bool white = route.rfind("/default/white/", 0) == 0;
        string file = lower(route.substr(15));
        const auto &pkg = white ? g_default_white : g_default_black;
        auto it = pkg.find(file);
        if (it == pkg.end()) respond(c, "404 Not Found", "text/plain", "not in the default skin");
        else respond(c, "200 OK", mime_of(file), it->second, "", hash_ext(ext_of(file)) != 0);
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
    } else if (route.rfind("/api/skins", 0) == 0) {
        std::ostringstream list;
        list << "[";
        bool firstEntry = true;
        auto addLabel = [&](const string &label) {
            if (!firstEntry) list << ",";
            firstEntry = false;
            list << "\"" << json_escape(label) << "\"";
        };
        std::error_code ec2;
        for (const auto &src : sess.sources) {
            if (src.label.empty()) continue;
            if (!src.files.empty() || skin_is_usable(src.root)) {
                addLabel(src.label);
                continue;
            }
            // a folder that only holds skins: offer each subskin it contains
            for (auto it = fs::directory_iterator(src.root, ec2);
                 !ec2 && it != fs::directory_iterator(); it.increment(ec2)) {
                if (!it->is_directory()) continue;
                if (skin_is_usable(it->path()))
                    addLabel(src.label + "/" + utf8(it->path().filename().wstring()));
            }
        }
        list << "]";
        { respond(c, "200 OK", "application/json; charset=utf-8", list.str()); shutdown(c, SD_SEND); closesocket(c); return; }
        // every folder under the skin root that carries its own skindef.txt is a
        // skin in its own right; the page lists them so any layout of folders works
        std::ostringstream o;
        o << "[";
        bool first = true;
        auto add = [&](const string &rel) {
            if (!first) o << ",";
            first = false;
            o << "\"" << json_escape(rel) << "\"";
        };
        add("");                                        // the root itself
        std::error_code ec;
        for (auto it = fs::directory_iterator(sess.root, ec); !ec && it != fs::directory_iterator(); it.increment(ec)) {
            if (!it->is_directory()) continue;
            fs::path def = it->path() / "skindef.txt";
            if (!fs::exists(def, ec)) continue;
            // a real skin points at layouts that exist next to its skindef; a
            // template folder references files that are not there
            string raw = read_file(def);
            std::wstring text;
            for (size_t i = 0; i + 1 < raw.size(); i += 2)
                text.push_back((wchar_t)((unsigned char)raw[i] | ((unsigned char)raw[i + 1] << 8)));
            bool usable = false;
            size_t pos = 0;
            while ((pos = text.find(L"skin:", pos)) != std::wstring::npos) {
                size_t eol = text.find(L'\n', pos);
                std::wstring line = text.substr(pos, eol == std::wstring::npos ? std::wstring::npos : eol - pos);
                size_t sp = line.find_last_of(L" \t\r");
                if (sp != std::wstring::npos) {
                    std::wstring file = line.substr(sp + 1);
                    if (file.size() > 4 && file.substr(file.size() - 4) == L".txt" &&
                        fs::exists(it->path() / fs::path(file), ec)) { usable = true; break; }
                }
                pos = eol == std::wstring::npos ? text.size() : eol;
            }
            if (!usable) continue;
            add(utf8(it->path().filename().wstring()));
        }
        o << "]";
        respond(c, "200 OK", "application/json; charset=utf-8", o.str());
    } else if (route.rfind("/api/version", 0) == 0) {
        string root = utf8(sess.root.filename().wstring());
        respond(c, "200 OK", "application/json; charset=utf-8",
                "{\"v\":\"" + json_escape(skin_fingerprint(sess)) +
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
        if (!cm.cover.empty())
            respond(c, "200 OK", cm.cover_mime.empty() ? "image/jpeg" : cm.cover_mime,
                    string((const char *)cm.cover.data(), cm.cover.size()), "", true);
        else respond(c, "404 Not Found", "text/plain", "no cover");
    } else if (route.rfind("/api/jump", 0) == 0) {
        int want = (int)std::strtol(query_value(target, "id").c_str(), nullptr, 10);
        int pos = sess.indexOf(want);
        if (pos >= 0) {
            sess.playingId = want;
            sess.playingPath = sess.tracks[pos].path;
        }
        respond(c, "200 OK", "application/json; charset=utf-8", info_json(sess));
    } else if (route.rfind("/api/started", 0) == 0) {
        // the page tells us playback really began; that, not a byte request, is
        // what makes a row "the one being heard"
        int want = (int)std::strtol(query_value(target, "id").c_str(), nullptr, 10);
        int pos = sess.indexOf(want);
        if (pos >= 0) { sess.playingId = want; sess.playingPath = sess.tracks[pos].path; }
        respond(c, "200 OK", "application/json; charset=utf-8", "{\"ok\":true}");
    } else if (route.rfind("/api/stop", 0) == 0) {
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
    if (!read_zip(buf, entries, skipped)) return out;
    for (auto &e : entries)
        out[lower(e.name)] = string((const char *)e.data.data(), e.data.size());
    return out;
}

// the format says a missing image comes from the black or the white default skin
static void load_default_skins() {
    g_default_black = unpack_resource(L"DEFAULT_BLACK");
    g_default_white = unpack_resource(L"DEFAULT_WHITE");
    printf("default skins: %zu black, %zu white\n", g_default_black.size(), g_default_white.size());
}

int main() {
    SetConsoleOutputCP(CP_UTF8);
    load_default_skins();        // needed before the skin argument is resolved
    setvbuf(stdout, nullptr, _IONBF, 0);   // the title line is wanted immediately

    // unicode-safe arguments (paths with CJK characters are common here)
    int argc = 0;
    LPWSTR *argvw = CommandLineToArgvW(GetCommandLineW(), &argc);


    fs::path skinArg;
    bool openBrowser = true;
    bool debugUrl = false;
    bool singleInstance = false;
    bool pinTop = false;
    std::vector<fs::path> args;
    for (int i = 1; i < argc; i++) {
        std::wstring arg = argvw[i];
        if (arg == L"--no-open") { openBrowser = false; continue; }
        if (arg == L"--debug") { debugUrl = true; continue; }
        if (arg == L"--single") { singleInstance = true; continue; }
        if (arg == L"--top") { pinTop = true; continue; }
        if (!arg.empty() && arg[0] == L'-') continue;      // unknown switch
        args.push_back(fs::path(arg));
    }
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

    // the first argument may be the skin; anything else is music
    std::vector<fs::path> inputs;
    if (!args.empty()) {
        const fs::path &first = args.front();
        bool looksLikeSkin = fs::is_directory(first) || is_playlist_ext(first) == false &&
                             (ext_of(first.filename().string()) == ".fbskin" ||
                              ext_of(first.filename().string()) == ".zip" ||
                              lower(first.filename().string()) == "skindef.txt") ||
                             fs::is_directory(first);
        if (fs::is_directory(first) || ext_of(first.filename().string()) == ".fbskin" ||
            ext_of(first.filename().string()) == ".zip" ||
            lower(first.filename().string()) == "skindef.txt") {
            skinArg = first;
            inputs.assign(args.begin() + 1, args.end());
        } else {
            inputs = args;
        }
        (void)looksLikeSkin;
    }

    fs::path root;
    std::map<string, string> pkgFiles;
    if (!skinArg.empty()) {
        string name = lower(skinArg.filename().string());
        if (name == "skindef.txt" || name == "skindef.skindef") root = skinArg.parent_path();
        else if (ext_of(name) == ".fbskin" || ext_of(name) == ".zip") {
            string raw = read_file(skinArg);
            vector<uint8_t> buf(raw.begin(), raw.end());
            vector<ZipEntry> entries;
            vector<string> skipped;
            if (!read_zip(buf, entries, skipped)) {
                printf("cannot read %s as a skin package\n", skinArg.string().c_str());
                return 1;
            }
            for (auto &e : entries) {
                pkgFiles[lower(e.name)] = string((const char *)e.data.data(), e.data.size());
            }
            strip_common_folder(pkgFiles);
            if (pkgFiles.empty()) {
                printf("package is empty or compressed, nothing to show\n");
                return 1;
            }
            root = skinArg;
        } else root = skinArg;
    }
    if (root.empty() || !fs::exists(root)) {
        root = fs::current_path();
        pkgFiles = g_default_black;      // nothing given: the built in default skin
    }

    Session sess;
    sess.root = fs::absolute(root);
    if (skinArg.empty()) {
        // nothing was opened: both built in skins are offered, and the white one
        // is what the app itself starts with
        sess.files.clear();
        remember_skin(sess, "White Skin", sess.root, g_default_white);
        remember_skin(sess, "Black Skin", sess.root, g_default_black);
        sess.active = 0;
        sess.files = sess.sources[0].files;   // the active package, served from memory
    } else {
        sess.files = pkgFiles;
        remember_skin(sess, utf8(sess.root.filename().wstring()), sess.root, std::move(pkgFiles));
    }

    for (auto &in : inputs) {
        if (is_playlist(in)) {
            for (auto &t : read_playlist(in)) sess.add(t);
        } else if (fs::is_regular_file(in) && is_audio(in)) {
            sess.add(fs::absolute(in));
        }
    }

    if (!sess.files.empty() && !skinArg.empty()) sess.root = fs::absolute(skinArg);
    // a list that arrives with the process starts on its first entry: selected
    // right away, and played if the browser allows it
    if (!sess.tracks.empty()) sess.playingId = sess.tracks.front().id;

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        printf("winsock failed\n");
        return 1;
    }
    SOCKET srv = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    addr.sin_port = 0;
    if (bind(srv, (sockaddr *)&addr, sizeof addr) != 0 || listen(srv, 16) != 0) {
        printf("cannot listen\n");
        return 1;
    }
    int len = sizeof addr;
    getsockname(srv, (sockaddr *)&addr, &len);
    int port = ntohs(addr.sin_port);
    {
        // several instances may run side by side; the port tells them apart
        wchar_t title[96];
        swprintf(title, 96, L"fbsv:%d", port);
        SetConsoleTitleW(title);
    }
    string url = "http://127.0.0.1:" + std::to_string(port) + "/" + (debugUrl ? "?debug" : "");

    {
        wchar_t wt[64];
        if (GetEnvironmentVariableW(L"WT_SESSION", wt, 64) > 0) printf("host   Windows Terminal\n");
        else printf("host   console host (no WT_SESSION)\n");
        HANDLE tok = nullptr;
        if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) {
            TOKEN_ELEVATION el{};
            DWORD sz = sizeof el;
            if (GetTokenInformation(tok, TokenElevation, &el, sz, &sz))
                printf("level  %s\n", el.TokenIsElevated ? "elevated" : "normal");
            CloseHandle(tok);
        }
    }
    printf("build  %s %s\n", __DATE__, __TIME__);
    printf("skin   %s\n", utf8(sess.root.wstring()).c_str());
    if (!sess.tracks.empty()) {
        const Track &first = sess.tracks.front();
        const Media &m0 = sess.meta_of(first.id);
        printf("track  %d/%d  %s\n", 1, (int)sess.tracks.size(),
               utf8(first.path.filename().wstring()).c_str());
        printf("tags   title=%s artist=%s album=%s\n", m0.title.c_str(), m0.artist.c_str(),
               m0.album.c_str());
        printf("cover  %s\n", m0.cover.empty() ? "none embedded" : "embedded");
    }
    printf("open   %s\n", url.c_str());
    printf("close this window to stop\n");
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
