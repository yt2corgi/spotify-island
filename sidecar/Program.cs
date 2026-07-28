using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Windows.Media;
using Windows.Media.Control;

namespace SmtcBridge;

// Minimal hand-written UI Automation COM interop (dotnet CLI can't build
// COMReference). Placeholders only hold vtable slots — never call them.
[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomation
{
    void _1(); void _2(); void _3();
    IUIAutomationElement ElementFromHandle(IntPtr hwnd);                      // slot 4
    void _5(); void _6(); void _7(); void _8(); void _9(); void _10();
    void _11(); void _12(); void _13(); void _14(); void _15(); void _16();
    void _17(); void _18(); void _19(); void _20();
    IUIAutomationCondition CreatePropertyCondition(int propertyId,            // slot 21
        [MarshalAs(UnmanagedType.Struct)] object value);
}

[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomationElement
{
    void _1(); void _2(); void _3();
    IUIAutomationElementArray FindAll(int scope, IUIAutomationCondition condition); // slot 4
    void _5(); void _6(); void _7(); void _8(); void _9(); void _10();
    void _11(); void _12(); void _13();
    [return: MarshalAs(UnmanagedType.IUnknown)]
    object GetCurrentPattern(int patternId);                                  // slot 14
    void _15(); void _16(); void _17(); void _18(); void _19(); void _20();
    string CurrentName { [return: MarshalAs(UnmanagedType.BStr)] get; }       // slot 21
}

[ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomationCondition { }

[ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomationElementArray
{
    int Length { get; }
    IUIAutomationElement GetElement(int index);
}

[ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomationInvokePattern
{
    void Invoke();
}

// Drives Spotify's own shuffle button via UI Automation, because SMTC only
// models shuffle as a bool and Spotify's cycle is off -> shuffle -> smart.
// State is inferred from the button's accessible name:
//   "Enable shuffle"       -> currently off
//   "Enable Smart Shuffle" -> currently normal shuffle
//   "Disable shuffle"      -> currently smart shuffle
internal static class SpotifyShuffle
{
    private static IUIAutomation? _uia;
    public static string Mode = "unknown"; // off | on | smart | unknown

    private static IUIAutomationElement? FindButton()
    {
        try
        {
            _uia ??= (IUIAutomation)Activator.CreateInstance(
                Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"))!)!;
            foreach (var p in System.Diagnostics.Process.GetProcessesByName("Spotify"))
            {
                var h = p.MainWindowHandle;
                if (h == IntPtr.Zero) continue;
                var root = _uia.ElementFromHandle(h);
                if (root == null) continue;
                var cond = _uia.CreatePropertyCondition(30003 /*ControlType*/, 50000 /*Button*/);
                var all = root.FindAll(4 /*TreeScope_Descendants*/, cond);
                for (int i = 0; i < all.Length; i++)
                {
                    var el = all.GetElement(i);
                    var name = el.CurrentName ?? "";
                    if (name.IndexOf("shuffle", StringComparison.OrdinalIgnoreCase) >= 0 &&
                        (name.StartsWith("Enable", StringComparison.OrdinalIgnoreCase) ||
                         name.StartsWith("Disable", StringComparison.OrdinalIgnoreCase)))
                        return el;
                }
            }
        }
        catch { }
        return null;
    }

    private static string ModeFromName(string name)
    {
        if (name.StartsWith("Disable", StringComparison.OrdinalIgnoreCase)) return "smart";
        if (name.IndexOf("smart", StringComparison.OrdinalIgnoreCase) >= 0) return "on";
        if (name.StartsWith("Enable", StringComparison.OrdinalIgnoreCase)) return "off";
        return "unknown";
    }

    private static IUIAutomationElement? _btn; // cached; tree search is slow

    private static string? SafeName(IUIAutomationElement? el)
    {
        try { return el?.CurrentName; } catch { return null; }
    }

    private static IUIAutomationElement? GetButton()
    {
        if (_btn != null && SafeName(_btn) != null) return _btn;
        _btn = FindButton();
        return _btn;
    }

    public static void Refresh()
    {
        var name = SafeName(GetButton());
        Mode = name == null ? "unknown" : ModeFromName(name);
    }

    public static async Task<bool> Cycle()
    {
        var b = GetButton();
        var before = SafeName(b);
        if (b == null || before == null) return false;
        try
        {
            var pat = (IUIAutomationInvokePattern)b.GetCurrentPattern(10000 /*Invoke*/);
            pat.Invoke();
        }
        catch { _btn = null; return false; }

        // Poll for the label flip instead of a fixed wait — usually <150ms.
        for (int i = 0; i < 8; i++)
        {
            await Task.Delay(70);
            var now = SafeName(b);
            if (now == null) { _btn = null; b = GetButton(); now = SafeName(b); }
            if (now != null && now != before) { Mode = ModeFromName(now); return true; }
        }
        Refresh();
        return true;
    }
}

// Streams the Windows media session (Spotify preferred) as JSON lines on stdout
// and accepts transport commands on stdin. Event-driven; idles at ~0% CPU.
// Spotify's per-app volume via the Windows audio mixer (WASAPI session).
internal static class SpotifyVolume
{
    private static readonly List<NAudio.CoreAudioApi.AudioSessionControl> Sessions = new();
    private static DateTimeOffset _found = DateTimeOffset.MinValue;

    private static void Find()
    {
        Sessions.Clear();
        try
        {
            using var en = new NAudio.CoreAudioApi.MMDeviceEnumerator();
            foreach (var dev in en.EnumerateAudioEndPoints(
                NAudio.CoreAudioApi.DataFlow.Render, NAudio.CoreAudioApi.DeviceState.Active))
            {
                var col = dev.AudioSessionManager.Sessions;
                if (col == null) continue;
                for (int i = 0; i < col.Count; i++)
                {
                    try
                    {
                        var s = col[i];
                        var pid = (int)s.GetProcessID;
                        if (pid == 0) continue;
                        var pn = System.Diagnostics.Process.GetProcessById(pid).ProcessName;
                        if (pn.Equals("Spotify", StringComparison.OrdinalIgnoreCase)) Sessions.Add(s);
                    }
                    catch { }
                }
            }
        }
        catch { }
        _found = DateTimeOffset.UtcNow;
    }

    private static void Ensure()
    {
        if (Sessions.Count == 0 || (DateTimeOffset.UtcNow - _found).TotalSeconds > 20) Find();
    }

    public static int Get()
    {
        Ensure();
        foreach (var s in Sessions)
        {
            try { return (int)Math.Round(s.SimpleAudioVolume.Volume * 100); } catch { }
        }
        return -1;
    }

    public static void Set(int pct)
    {
        Ensure();
        float v = Math.Clamp(pct, 0, 100) / 100f;
        bool ok = false;
        foreach (var s in Sessions)
        {
            try { s.SimpleAudioVolume.Volume = v; ok = true; } catch { }
        }
        if (!ok)
        {
            Find();
            foreach (var s in Sessions)
            {
                try { s.SimpleAudioVolume.Volume = v; } catch { }
            }
        }
    }
}

internal static class Program
{
    private static GlobalSystemMediaTransportControlsSessionManager _manager = null!;
    private static GlobalSystemMediaTransportControlsSession? _session;
    private static readonly SemaphoreSlim Signal = new(1, int.MaxValue);
    private static readonly object OutLock = new();
    private static string? _artKey;
    private static bool? _lastShuffleBool;
    private static DateTimeOffset _lastModeRefresh = DateTimeOffset.MinValue;

    private static async Task<int> Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            _manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        }
        catch (Exception e)
        {
            Emit(new { type = "fatal", error = e.Message });
            return 1;
        }

        _manager.SessionsChanged += (_, _) => { AttachSession(); Bump(); };
        AttachSession();

        _ = Task.Run(ReadStdin);
        _ = Task.Run(Heartbeat);

        while (true)
        {
            await Signal.WaitAsync();
            await Task.Delay(60); // coalesce event bursts
            while (Signal.CurrentCount > 0) await Signal.WaitAsync();
            try { await EmitState(); }
            catch (Exception e) { Emit(new { type = "err", error = e.Message }); }
        }
    }

    private static void Bump()
    {
        try { Signal.Release(); } catch (SemaphoreFullException) { }
    }

    // Safety net for the rare missed event; also keeps the timeline honest.
    private static async Task Heartbeat()
    {
        while (true)
        {
            await Task.Delay(5000);
            Bump();
        }
    }

    private static void AttachSession()
    {
        GlobalSystemMediaTransportControlsSession? pick = null;
        try
        {
            foreach (var s in _manager.GetSessions())
            {
                if ((s.SourceAppUserModelId ?? "").Contains("spotify", StringComparison.OrdinalIgnoreCase))
                {
                    pick = s;
                    break;
                }
            }
            pick ??= _manager.GetCurrentSession();
        }
        catch { }

        if (pick?.SourceAppUserModelId == _session?.SourceAppUserModelId && (pick == null) == (_session == null))
            return;

        if (_session != null)
        {
            _session.MediaPropertiesChanged -= OnMediaChanged;
            _session.PlaybackInfoChanged -= OnPlaybackChanged;
            _session.TimelinePropertiesChanged -= OnTimelineChanged;
        }

        _session = pick;
        _artKey = null;

        if (_session != null)
        {
            _session.MediaPropertiesChanged += OnMediaChanged;
            _session.PlaybackInfoChanged += OnPlaybackChanged;
            _session.TimelinePropertiesChanged += OnTimelineChanged;
        }
    }

    private static void OnMediaChanged(GlobalSystemMediaTransportControlsSession s, MediaPropertiesChangedEventArgs a) => Bump();
    private static void OnPlaybackChanged(GlobalSystemMediaTransportControlsSession s, PlaybackInfoChangedEventArgs a) => Bump();
    private static void OnTimelineChanged(GlobalSystemMediaTransportControlsSession s, TimelinePropertiesChangedEventArgs a) => Bump();

    private static async Task EmitState()
    {
        var s = _session;
        if (s == null)
        {
            Emit(new { type = "state", available = false });
            return;
        }

        var pb = s.GetPlaybackInfo();
        var tl = s.GetTimelineProperties();
        GlobalSystemMediaTransportControlsSessionMediaProperties? mp = null;
        try { mp = await s.TryGetMediaPropertiesAsync(); } catch { }

        bool playing = pb.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        var now = DateTimeOffset.UtcNow;

        // Keep the tri-state shuffle mode fresh: whenever the SMTC bool flips
        // (user used Spotify's UI) or every 30s as a safety net.
        bool curShuffleBool = pb.IsShuffleActive ?? false;
        if (curShuffleBool != _lastShuffleBool || (now - _lastModeRefresh).TotalSeconds > 30)
        {
            _lastShuffleBool = curShuffleBool;
            _lastModeRefresh = now;
            SpotifyShuffle.Refresh();
        }

        double pos = tl.Position.TotalMilliseconds;
        if (playing) pos += (now - tl.LastUpdatedTime).TotalMilliseconds;
        double dur = tl.EndTime.TotalMilliseconds;
        if (pos < 0) pos = 0;
        if (dur > 0 && pos > dur) pos = dur;

        string title = mp?.Title ?? "";
        string artist = mp?.Artist ?? "";
        string album = mp?.AlbumTitle ?? "";

        Emit(new
        {
            type = "state",
            available = true,
            app = s.SourceAppUserModelId ?? "",
            title,
            artist,
            album,
            playing,
            status = pb.PlaybackStatus.ToString(),
            positionMs = (long)pos,
            durationMs = (long)dur,
            shuffle = pb.IsShuffleActive ?? false,
            shuffleMode = SpotifyShuffle.Mode,
            volume = SpotifyVolume.Get(),
            repeat = (pb.AutoRepeatMode ?? MediaPlaybackAutoRepeatMode.None).ToString(),
            canSeek = pb.Controls.IsPlaybackPositionEnabled,
            canNext = pb.Controls.IsNextEnabled,
            canPrev = pb.Controls.IsPreviousEnabled,
            ts = now.ToUnixTimeMilliseconds()
        });

        var key = title + "" + artist + "" + album;
        if (key != _artKey)
        {
            _artKey = key;
            string? b64 = null;
            try
            {
                if (mp?.Thumbnail != null)
                {
                    using var ra = await mp.Thumbnail.OpenReadAsync();
                    using var stream = ra.AsStreamForRead();
                    using var ms = new MemoryStream();
                    await stream.CopyToAsync(ms);
                    if (ms.Length > 0) b64 = Convert.ToBase64String(ms.ToArray());
                }
            }
            catch { }
            Emit(new { type = "art", data = b64 });
        }
    }

    private static async Task ReadStdin()
    {
        string? line;
        while ((line = await Console.In.ReadLineAsync()) != null)
        {
            try { await Handle(line.Trim()); } catch { }
        }
        Environment.Exit(0); // parent died
    }

    private static async Task Handle(string line)
    {
        var s = _session;
        if (s == null || line.Length == 0) return;
        var pb = s.GetPlaybackInfo();

        var parts = line.Split(' ', 2);
        switch (parts[0])
        {
            case "playpause": await s.TryTogglePlayPauseAsync(); break;
            case "play": await s.TryPlayAsync(); break;
            case "pause": await s.TryPauseAsync(); break;
            case "next": await s.TrySkipNextAsync(); break;
            case "prev": await s.TrySkipPreviousAsync(); break;
            case "seek":
                if (parts.Length == 2 && long.TryParse(parts[1], out var ms))
                    await s.TryChangePlaybackPositionAsync(ms * 10000);
                break;
            case "vol":
                if (parts.Length == 2 && int.TryParse(parts[1], out var pct))
                    SpotifyVolume.Set(pct);
                return; // no bump needed — the client already shows the new value
            case "shuffle":
            {
                // Preferred: click Spotify's own button so the cycle matches
                // Spotify exactly (off -> shuffle -> smart shuffle -> off).
                if (await SpotifyShuffle.Cycle()) { Bump(); break; }

                // Fallback (Spotify window unavailable / non-English labels):
                // plain SMTC toggle, verified so smart shuffle can't strand it.
                bool desired = !(pb.IsShuffleActive ?? false);
                for (int i = 0; i < 3; i++)
                {
                    await s.TryChangeShuffleActiveAsync(desired);
                    await Task.Delay(300);
                    if ((s.GetPlaybackInfo().IsShuffleActive ?? false) == desired) break;
                }
                break;
            }
            case "repeat":
                var next = (pb.AutoRepeatMode ?? MediaPlaybackAutoRepeatMode.None) switch
                {
                    MediaPlaybackAutoRepeatMode.None => MediaPlaybackAutoRepeatMode.List,
                    MediaPlaybackAutoRepeatMode.List => MediaPlaybackAutoRepeatMode.Track,
                    _ => MediaPlaybackAutoRepeatMode.None
                };
                await s.TryChangeAutoRepeatModeAsync(next);
                break;
        }

        _ = Task.Run(async () => { await Task.Delay(150); Bump(); });
    }

    private static void Emit(object obj)
    {
        lock (OutLock)
        {
            Console.WriteLine(JsonSerializer.Serialize(obj));
            Console.Out.Flush();
        }
    }
}
