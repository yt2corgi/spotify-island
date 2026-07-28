using System.Text;
using System.Text.Json;
using Windows.Media;
using Windows.Media.Control;

namespace SmtcBridge;

// Streams the Windows media session (Spotify preferred) as JSON lines on stdout
// and accepts transport commands on stdin. Event-driven; idles at ~0% CPU.
internal static class Program
{
    private static GlobalSystemMediaTransportControlsSessionManager _manager = null!;
    private static GlobalSystemMediaTransportControlsSession? _session;
    private static readonly SemaphoreSlim Signal = new(1, int.MaxValue);
    private static readonly object OutLock = new();
    private static string? _artKey;

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
            case "shuffle":
            {
                // Spotify's smart shuffle is a third state SMTC can't see: one
                // "off" command can land on normal shuffle instead of off.
                // Verify the result and re-send until the requested state sticks.
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
