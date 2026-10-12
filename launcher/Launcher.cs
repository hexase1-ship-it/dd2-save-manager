// DD2SaveManager.exe - starts the local server without a console window and shows the UI in a
// frameless window of its own (a WebView2 control filling a borderless form; the page draws the
// title bar). Closing the window ends the program.
//
// Where the WebView2 runtime is missing it falls back to an Edge or Chrome app window, and
// without either of those to the default browser.
//
// Built with the C# compiler that ships with Windows (C# 5), see build.bat. Needs Node.js: a
// copy in runtime\ next to the exe is used first, then an installed one.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("DD2 Save Manager")]
[assembly: AssemblyProduct("DD2 Save Manager")]
[assembly: AssemblyVersion("1.0.2.0")]

static class Launcher
{
    public const string Title = "DD2 Save Manager";
    const int ServerStartTimeoutMs = 15000;
    const int WindowAppearTimeoutMs = 20000;
    const int WindowCloseGraceMs = 3000;
    const uint WM_CLOSE = 0x0010;
    const int SW_RESTORE = 9;

    delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string className, string windowName);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);

    public static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    public static readonly string AppData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DD2SaveManager");
    static readonly string Libraries = Path.Combine(Root, "bin");
    public static int Port = 47820;
    public static string Url { get { return "http://127.0.0.1:" + Port + "/"; } }

    // Test switches: --port N (a port that does not collide with a copy already running),
    // --minimized, and --capture FILE [--capture-script FILE] [--capture-delay MS] [--capture-size WxH],
    // which draws the window off screen, saves a picture of it and exits.
    public static bool Minimized;
    public static string CaptureFile;
    public static string CaptureScript;
    public static Size CaptureSize = new Size(1320, 900);
    public static int CaptureDelayMs = 2500;

    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // The WebView2 assemblies live in bin\, away from the files a player needs to see.
        AppDomain.CurrentDomain.AssemblyResolve += (sender, e) =>
        {
            string file = Path.Combine(Libraries, new AssemblyName(e.Name).Name + ".dll");
            return File.Exists(file) ? Assembly.LoadFrom(file) : null;
        };

        Minimized = Array.IndexOf(args, "--minimized") >= 0;
        string value;
        if (Option(args, "--port", out value)) Port = int.Parse(value);
        Option(args, "--capture", out CaptureFile);
        Option(args, "--capture-script", out CaptureScript);
        if (Option(args, "--capture-delay", out value)) CaptureDelayMs = int.Parse(value);
        if (Option(args, "--capture-size", out value))
        {
            string[] size = value.Split('x');
            CaptureSize = new Size(int.Parse(size[0]), int.Parse(size[1]));
        }

        if (!File.Exists(Path.Combine(Root, "src", "server.js")))
        {
            Fail(Text.Get("missingFiles"));
            return 1;
        }

        bool first;
        using (new Mutex(true, "DD2SaveManager.Launcher." + Port, out first))
        {
            // Already running: bring its window forward and leave.
            if (!first)
            {
                IntPtr running = FindWindow(null, Title);
                if (running != IntPtr.Zero)
                {
                    if (IsIconic(running)) ShowWindow(running, SW_RESTORE);
                    SetForegroundWindow(running);
                }
                return 0;
            }

            Directory.CreateDirectory(AppData);
            Process node = null;
            try
            {
                // A server may already be up when it was started from the console script. One
                // left running from before an update would serve the old program, so say so.
                if (IsServing())
                {
                    if (Fetch(Url + "version") != ExpectedVersion())
                    {
                        Fail(Text.Get("staleServer"));
                        return 1;
                    }
                }
                else
                {
                    string nodeExe = FindNode();
                    if (nodeExe == null)
                    {
                        Fail(Text.Get("noNode"));
                        return 1;
                    }
                    node = StartServer(nodeExe);
                    if (!WaitUntilServing(node))
                    {
                        Fail(Text.Get("startFailed") + "\n" + Path.Combine(AppData, "server.log"));
                        return 1;
                    }
                }

                if (!Host.Run()) RunInBrowser();
            }
            finally
            {
                if (node != null && !node.HasExited)
                {
                    try { node.Kill(); } catch (Exception) { }
                }
            }
        }
        return 0;
    }

    static bool Option(string[] args, string name, out string value)
    {
        int at = Array.IndexOf(args, name);
        value = at >= 0 && at + 1 < args.Length ? args[at + 1] : null;
        return value != null;
    }

    public static void Log(string line)
    {
        try
        {
            Directory.CreateDirectory(AppData);
            File.AppendAllText(Path.Combine(AppData, "launcher.log"), DateTime.Now.ToString("s") + " " + line + Environment.NewLine, new UTF8Encoding(false));
        }
        catch (IOException) { }
    }

    static void Fail(string message)
    {
        // Automated checks set this so a failure is recorded instead of waiting on a dialog.
        if (Environment.GetEnvironmentVariable("DD2SM_SILENT") != null || CaptureFile != null)
        {
            Directory.CreateDirectory(AppData);
            File.WriteAllText(Path.Combine(AppData, "last-error.txt"), message, new UTF8Encoding(false));
            return;
        }
        MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    /// <summary>What a server of this copy answers on /version.</summary>
    static string ExpectedVersion()
    {
        try
        {
            string package = File.ReadAllText(Path.Combine(Root, "package.json"));
            int at = package.IndexOf("\"version\"");
            int open = package.IndexOf('"', package.IndexOf(':', at) + 1);
            int close = package.IndexOf('"', open + 1);
            return "{\"version\":\"" + package.Substring(open + 1, close - open - 1) + "\"}";
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Body of a local GET, or null when it fails.</summary>
    static string Fetch(string address)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(address);
            request.Timeout = 1500;
            request.Proxy = null;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }
        catch (WebException)
        {
            return null;
        }
    }

    static string FindNode()
    {
        // A copy shipped with the program comes first, so a release works on a PC without Node.js.
        string bundled = Path.Combine(Root, "runtime", "node.exe");
        if (File.Exists(bundled)) return bundled;
        foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (dir.Trim().Length == 0) continue;
            try
            {
                string candidate = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { }
        }
        string programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs");
        string[] fixedPlaces =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(programs, "nodejs", "node.exe"),
        };
        foreach (string candidate in fixedPlaces) if (File.Exists(candidate)) return candidate;
        if (Directory.Exists(programs))
        {
            foreach (string dir in Directory.GetDirectories(programs, "node-v*"))
            {
                string candidate = Path.Combine(dir, "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
        }
        return null;
    }

    static Process StartServer(string nodeExe)
    {
        var info = new ProcessStartInfo(nodeExe)
        {
            // The server stops by itself if this launcher disappears without cleaning up.
            Arguments = "\"" + Path.Combine("src", "server.js") + "\" --no-open --port " + Port + " --parent-pid " + Process.GetCurrentProcess().Id,
            WorkingDirectory = Root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        var log = new StreamWriter(Path.Combine(AppData, "server.log"), false, new UTF8Encoding(false)) { AutoFlush = true };
        var process = new Process { StartInfo = info };
        DataReceivedEventHandler write = (sender, e) =>
        {
            if (e.Data == null) return;
            lock (log) log.WriteLine(e.Data);
        };
        process.OutputDataReceived += write;
        process.ErrorDataReceived += write;
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    static bool IsServing()
    {
        return Fetch(Url) != null;
    }

    static bool WaitUntilServing(Process node)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < ServerStartTimeoutMs)
        {
            if (node.HasExited) return false;
            if (IsServing()) return true;
            Thread.Sleep(150);
        }
        return false;
    }

    // -----------------------------------------------------------------------------------
    // Fallback: the UI in a browser's app window, for PCs without the WebView2 runtime.

    static void RunInBrowser()
    {
        Process browser = OpenBrowserWindow();
        if (browser != null) WaitForWindowToClose(browser);
        else Application.Run(new FallbackForm());
    }

    static string FindBrowser()
    {
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string pf = Environment.GetEnvironmentVariable("ProgramW6432") ?? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidates =
        {
            Path.Combine(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(pf, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(pf86, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(local, "Google", "Chrome", "Application", "chrome.exe"),
        };
        foreach (string candidate in candidates) if (File.Exists(candidate)) return candidate;
        return null;
    }

    /// <summary>
    /// Opens the UI as an app window. Returns the browser process that lives as long as the
    /// window does, or null when only the default browser could be used.
    /// </summary>
    static Process OpenBrowserWindow()
    {
        string browser = FindBrowser();
        if (browser == null)
        {
            Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
            return null;
        }
        // A profile of its own keeps the window's process separate from the user's everyday
        // browser, so waiting for it to exit means waiting for this window to close.
        string profile = Path.Combine(AppData, "window");
        var info = new ProcessStartInfo(browser)
        {
            Arguments = "--app=" + Url + " --user-data-dir=\"" + profile + "\" --window-size=1320,920"
                // Extensions registered machine-wide install themselves into any new profile and
                // open their welcome tabs in a second window; this window needs none of them.
                + " --no-first-run --no-default-browser-check --disable-background-mode --disable-extensions",
            // The window style is only passed on by a shell launch.
            UseShellExecute = Minimized,
            WindowStyle = Minimized ? ProcessWindowStyle.Minimized : ProcessWindowStyle.Normal,
        };
        return Process.Start(info);
    }

    /// <summary>Visible top-level windows of a process, with their titles.</summary>
    static List<KeyValuePair<IntPtr, string>> WindowsOf(Process process)
    {
        var found = new List<KeyValuePair<IntPtr, string>>();
        uint id = (uint)process.Id;
        EnumWindows((window, parameter) =>
        {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner == id && IsWindowVisible(window))
            {
                var text = new StringBuilder(256);
                GetWindowText(window, text, text.Capacity);
                found.Add(new KeyValuePair<IntPtr, string>(window, text.ToString()));
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /// <summary>
    /// Returns when the app window is closed. The browser process itself can outlive the window
    /// (other windows, background tasks), so the window is what is watched; whatever is left of
    /// the private browser profile is then closed too.
    /// </summary>
    static void WaitForWindowToClose(Process browser)
    {
        IntPtr app = IntPtr.Zero;
        var clock = Stopwatch.StartNew();
        while (app == IntPtr.Zero && !browser.HasExited && clock.ElapsedMilliseconds < WindowAppearTimeoutMs)
        {
            foreach (var window in WindowsOf(browser))
            {
                // The title is the page title once loaded and the address before that; the page
                // title starts with "DD2" in every language.
                if (window.Value.StartsWith("DD2") || window.Value.Contains("127.0.0.1:" + Port)) app = window.Key;
            }
            if (app == IntPtr.Zero) Thread.Sleep(200);
        }
        if (app == IntPtr.Zero)
        {
            browser.WaitForExit();
            return;
        }
        while (IsWindow(app) && !browser.HasExited) Thread.Sleep(300);
        if (browser.HasExited) return;
        foreach (var window in WindowsOf(browser)) PostMessage(window.Key, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        if (!browser.WaitForExit(WindowCloseGraceMs))
        {
            try { browser.Kill(); } catch (Exception) { }
        }
    }

    /// <summary>Shown only when neither WebView2, Edge nor Chrome is there.</summary>
    sealed class FallbackForm : Form
    {
        public FallbackForm()
        {
            Text = Title;
            ClientSize = new Size(460, 140);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Controls.Add(new Label { Text = global::Text.Get("inBrowser"), Location = new Point(20, 20), Size = new Size(420, 55) });
            var open = new Button { Text = global::Text.Get("openAgain"), Location = new Point(20, 90), Size = new Size(160, 30) };
            open.Click += (sender, e) => Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
            var close = new Button { Text = global::Text.Get("quit"), Location = new Point(320, 90), Size = new Size(120, 30) };
            close.Click += (sender, e) => Close();
            Controls.Add(open);
            Controls.Add(close);
        }
    }
}

/// <summary>The few sentences the launcher itself may have to say, in the languages of the program.</summary>
static class Text
{
    static readonly Dictionary<string, string[]> Table = new Dictionary<string, string[]>
    {
        // en, ko, ja, zh, es, fr
        { "missingFiles", new[] {
            "The program's files were not found.\nRun this exe from its own folder, next to the src and web folders.",
            "프로그램 파일을 찾을 수 없어요.\n이 exe를 원래 있던 폴더(src, web 폴더와 같은 위치)에서 실행해 주세요.",
            "プログラムのファイルが見つかりません。\nこの exe は元のフォルダー (src、web フォルダーと同じ場所) で実行してください。",
            "找不到程序文件。\n请在原文件夹（与 src、web 文件夹相同的位置）中运行此 exe。",
            "No se encontraron los archivos del programa.\nEjecuta este exe desde su carpeta, junto a las carpetas src y web.",
            "Les fichiers du programme sont introuvables.\nLancez cet exe depuis son dossier, à côté des dossiers src et web." } },
        { "staleServer", new[] {
            "An earlier copy of the program is still running.\nClose it, then start the program again.",
            "이전에 실행한 창이 아직 켜져 있어요.\n먼저 실행해 둔 창을 닫은 뒤 다시 실행해 주세요.",
            "以前に起動したプログラムがまだ動いています。\nそれを閉じてから、もう一度起動してください。",
            "之前启动的程序仍在运行。\n请先关闭它，然后重新启动。",
            "Una copia anterior del programa sigue abierta.\nCiérrala y vuelve a iniciar el programa.",
            "Une copie précédente du programme est encore ouverte.\nFermez-la, puis relancez le programme." } },
        { "noNode", new[] {
            "Node.js was not found.\nInstall it from https://nodejs.org and start the program again.",
            "Node.js가 설치되어 있지 않아요.\nhttps://nodejs.org 에서 설치한 뒤 다시 실행해 주세요.",
            "Node.js が見つかりません。\nhttps://nodejs.org からインストールして、もう一度起動してください。",
            "未找到 Node.js。\n请从 https://nodejs.org 安装后重新启动程序。",
            "No se encontró Node.js.\nInstálalo desde https://nodejs.org y vuelve a iniciar el programa.",
            "Node.js est introuvable.\nInstallez-le depuis https://nodejs.org, puis relancez le programme." } },
        { "startFailed", new[] {
            "The program could not start.\nDetails are in the file below.",
            "프로그램을 시작하지 못했어요.\n자세한 내용은 아래 파일에 적혀 있어요.",
            "プログラムを起動できませんでした。\n詳細は次のファイルに記録されています。",
            "程序未能启动。\n详细信息记录在以下文件中。",
            "No se pudo iniciar el programa.\nLos detalles están en el archivo siguiente.",
            "Le programme n'a pas pu démarrer.\nLes détails se trouvent dans le fichier ci-dessous." } },
        { "inBrowser", new[] {
            "The screen was opened in your browser.\nClosing this window ends the program.",
            "브라우저에 화면을 열었어요.\n이 창을 닫으면 프로그램이 종료돼요.",
            "ブラウザーに画面を開きました。\nこのウィンドウを閉じるとプログラムが終了します。",
            "已在浏览器中打开界面。\n关闭此窗口将退出程序。",
            "La pantalla se abrió en tu navegador.\nAl cerrar esta ventana el programa termina.",
            "L'écran s'est ouvert dans votre navigateur.\nFermer cette fenêtre quitte le programme." } },
        { "openAgain", new[] { "Open again", "화면 다시 열기", "もう一度開く", "重新打开", "Abrir de nuevo", "Rouvrir" } },
        { "quit", new[] { "Quit", "종료", "終了", "退出", "Salir", "Quitter" } },
    };
    static readonly string[] Codes = { "en", "ko", "ja", "zh", "es", "fr" };

    public static string Get(string key)
    {
        int language = Math.Max(0, Array.IndexOf(Codes, CultureInfo.CurrentUICulture.TwoLetterISOLanguageName));
        return Table[key][language];
    }
}

/// <summary>
/// The frameless window. Kept apart from Launcher so that nothing here is touched (and no
/// WebView2 assembly is loaded) before the launcher has set up where those assemblies are.
/// </summary>
static class Host
{
    /// <summary>Shows the UI in its own window until it is closed. False when WebView2 cannot be used.</summary>
    public static bool Run()
    {
        try
        {
            CoreWebView2Environment.SetLoaderDllFolderPath(Path.Combine(Launcher.Root, "bin"));
            string runtime = CoreWebView2Environment.GetAvailableBrowserVersionString();
            if (string.IsNullOrEmpty(runtime)) return false;
        }
        catch (Exception error)
        {
            // No runtime, or the WebView2 files next to the exe are missing.
            Launcher.Log("WebView2 unavailable: " + error.Message);
            return false;
        }
        var window = new AppWindow();
        Application.Run(window);
        return !window.Failed;
    }
}

sealed class AppWindow : Form
{
    const int WM_NCCALCSIZE = 0x0083;
    const int WM_NCLBUTTONDOWN = 0x00A1;
    const int HTTOP = 12;
    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    const int DWMWA_BORDER_COLOR = 34;
    // The page's canvas and hairline colours (web/styles.css), so nothing flashes around the page.
    static readonly Color Canvas = Color.FromArgb(0x0e, 0x0c, 0x09);
    const int BorderColorRef = 0x00222629; // 0x00BBGGRR of the hairline

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, int message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    readonly WebView2 view = new WebView2();
    readonly string placementFile = Path.Combine(Launcher.AppData, "window.txt");
    readonly bool capturing = Launcher.CaptureFile != null;
    public bool Failed;

    public AppWindow()
    {
        Text = Launcher.Title;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        BackColor = Canvas;
        StartPosition = FormStartPosition.Manual;
        // Sizes are in the units of an unscaled (96 dpi) screen.
        float scale;
        using (var graphics = CreateGraphics()) scale = graphics.DpiX / 96f;
        MinimumSize = new Size((int)(980 * scale), (int)(640 * scale));
        if (capturing)
        {
            // Drawn where nobody sees it and without taking the focus from what the user is doing.
            ShowInTaskbar = false;
            Bounds = new Rectangle(-32000, -32000, Launcher.CaptureSize.Width, Launcher.CaptureSize.Height);
        }
        else
        {
            RestorePlacement(scale);
            if (Launcher.Minimized) WindowState = FormWindowState.Minimized;
        }
        view.Dock = DockStyle.Fill;
        view.DefaultBackgroundColor = Canvas;
        Controls.Add(view);
        Load += (sender, e) => Start();
        Resize += (sender, e) => TellWindowState();
        FormClosing += (sender, e) => { if (!capturing) SavePlacement(); };
    }

    protected override bool ShowWithoutActivation { get { return capturing; } }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // A dark frame edge in the page's hairline colour; older Windows ignore what they do not know.
        int on = 1;
        DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref on, sizeof(int));
        int border = BorderColorRef;
        DwmSetWindowAttribute(Handle, DWMWA_BORDER_COLOR, ref border, sizeof(int));
    }

    /// <summary>
    /// Keeps the window a normal resizable one (borders, snapping, shadow, rounded corners) but
    /// gives the title bar's space to the page: the client area is made to start at the very top.
    /// </summary>
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
        {
            var before = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
            base.WndProc(ref m);
            var after = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
            // A maximized window hangs over the screen edge by the width of its frame, which is
            // what was just taken off its left side (right for the screen the window is on).
            after.Top = before.Top + (IsZoomed(Handle) ? after.Left - before.Left : 0);
            Marshal.StructureToPtr(after, m.LParam, false);
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
    }

    async void Start()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Launcher.AppData, "webview"));
            await view.EnsureCoreWebView2Async(environment);
            var settings = view.CoreWebView2.Settings;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.AreDevToolsEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            settings.IsSwipeNavigationEnabled = false;
            // Lets the page mark its title bar as the place to drag the window by (app-region: drag).
            settings.IsNonClientRegionSupportEnabled = true;

            // The browser's own menu (back, print, inspect) has no place here; text fields keep theirs.
            view.CoreWebView2.ContextMenuRequested += (sender, e) => { if (!e.ContextMenuTarget.IsEditable) e.Handled = true; };
            view.CoreWebView2.NewWindowRequested += (sender, e) => { e.Handled = true; };
            view.CoreWebView2.NavigationStarting += (sender, e) => { if (!e.Uri.StartsWith(Launcher.Url)) e.Cancel = true; };
            view.CoreWebView2.WebMessageReceived += (sender, e) => OnPageMessage(e.WebMessageAsJson);
            view.CoreWebView2.ProcessFailed += (sender, e) => Launcher.Log("WebView2 process failed: " + e.ProcessFailedKind);
            if (capturing) view.CoreWebView2.NavigationCompleted += (sender, e) => CaptureAndExit();
            view.CoreWebView2.Navigate(Launcher.Url);
        }
        catch (Exception error)
        {
            Launcher.Log("WebView2 could not start: " + error);
            Failed = true;
            Close();
        }
    }

    /// <summary>Window commands from the page's own title bar: {"type":"window","action":"..."}.</summary>
    void OnPageMessage(string json)
    {
        if (json.IndexOf("\"type\":\"window\"", StringComparison.Ordinal) < 0) return;
        if (Has(json, "minimize")) WindowState = FormWindowState.Minimized;
        else if (Has(json, "maximize")) WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
        else if (Has(json, "close")) Close();
        else if (Has(json, "resize-top"))
        {
            // The top edge belongs to the page, so the page says when a resize starts there.
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTTOP, IntPtr.Zero);
        }
        else if (Has(json, "ready")) TellWindowState();
    }

    static bool Has(string json, string action)
    {
        return json.IndexOf("\"action\":\"" + action + "\"", StringComparison.Ordinal) >= 0;
    }

    void TellWindowState()
    {
        if (view.CoreWebView2 == null) return;
        view.CoreWebView2.PostWebMessageAsJson("{\"type\":\"window-state\",\"maximized\":" + (WindowState == FormWindowState.Maximized ? "true" : "false") + "}");
    }

    // Size and position are remembered between runs: "x,y,width,height,maximized".
    void RestorePlacement(float scale)
    {
        var screen = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(Math.Min(screen.Width, (int)(1320 * scale)), Math.Min(screen.Height, (int)(900 * scale)));
        Location = new Point(screen.Left + Math.Max(0, (screen.Width - Width) / 2), screen.Top + Math.Max(0, (screen.Height - Height) / 2));
        try
        {
            if (!File.Exists(placementFile)) return;
            string[] parts = File.ReadAllText(placementFile).Split(',');
            var bounds = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
            // Only where a screen still is; a monitor may have gone since.
            foreach (var display in Screen.AllScreens)
            {
                if (!display.WorkingArea.IntersectsWith(bounds)) continue;
                Bounds = bounds;
                if (parts[4].Trim() == "1") WindowState = FormWindowState.Maximized;
                break;
            }
        }
        catch (Exception) { }
    }

    void SavePlacement()
    {
        try
        {
            var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            File.WriteAllText(placementFile, string.Join(",", bounds.X, bounds.Y, bounds.Width, bounds.Height, WindowState == FormWindowState.Maximized ? 1 : 0));
        }
        catch (IOException) { }
    }

    /// <summary>Test mode: waits for the page to settle, optionally runs a script, saves a picture, exits.</summary>
    async void CaptureAndExit()
    {
        try
        {
            await Task.Delay(3500);
            if (Launcher.CaptureScript != null)
            {
                await view.CoreWebView2.ExecuteScriptAsync(File.ReadAllText(Launcher.CaptureScript));
                await Task.Delay(Launcher.CaptureDelayMs);
            }
            using (var file = File.Create(Launcher.CaptureFile))
            {
                await view.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
            }
        }
        catch (Exception error)
        {
            Launcher.Log("capture failed: " + error);
        }
        Close();
    }
}
