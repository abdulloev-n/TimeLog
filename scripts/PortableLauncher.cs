using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class PortableLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string root = Environment.GetEnvironmentVariable("TIMELOG_PORTABLE_CACHE");
            if (String.IsNullOrWhiteSpace(root))
                root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), PortableInfo.Name, "portable-cache");
            root = Path.GetFullPath(root);
            string target = Path.Combine(root, PortableInfo.Version + "-" + PortableInfo.Hash.Substring(0, 16));
            string executable = Path.Combine(target, PortableInfo.Name + ".exe");
            Directory.CreateDirectory(root);
            using (Mutex mutex = new Mutex(false, "Local\\TimeLogPortable-" + PortableInfo.Hash.Substring(0, 16)))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(TimeSpan.FromMinutes(3)); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new IOException("Another copy is still preparing the app. Try again in a minute.");
                try
                {
                    if (!File.Exists(executable) || !File.Exists(Path.Combine(target, ".ready")))
                    {
                        if (Directory.Exists(target)) Directory.Delete(target, true);
                        string temporary = target + ".extract-" + Guid.NewGuid().ToString("N");
                        Directory.CreateDirectory(temporary);
                        try
                        {
                            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("timelog.payload.zip"))
                            {
                                if (payload == null) throw new IOException("The app payload is missing.");
                                using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read))
                                {
                                    string prefix = Path.GetFullPath(temporary) + Path.DirectorySeparatorChar;
                                    foreach (ZipArchiveEntry entry in archive.Entries)
                                    {
                                        string file = Path.GetFullPath(Path.Combine(temporary, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                                        if (!file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid path in app payload.");
                                        if (entry.Name.Length == 0) { Directory.CreateDirectory(file); continue; }
                                        Directory.CreateDirectory(Path.GetDirectoryName(file));
                                        using (Stream input = entry.Open())
                                        using (FileStream output = new FileStream(file, FileMode.CreateNew, FileAccess.Write)) input.CopyTo(output);
                                    }
                                }
                            }
                            if (!File.Exists(Path.Combine(temporary, PortableInfo.Name + ".exe"))) throw new IOException("The app executable is missing.");
                            File.WriteAllText(Path.Combine(temporary, ".ready"), PortableInfo.Hash);
                            Directory.Move(temporary, target);
                        }
                        finally { if (Directory.Exists(temporary)) Directory.Delete(temporary, true); }
                    }
                }
                finally { mutex.ReleaseMutex(); }
            }
            StringBuilder command = new StringBuilder();
            foreach (string argument in args) { if (command.Length > 0) command.Append(' '); command.Append(Quote(argument)); }
            ProcessStartInfo start = new ProcessStartInfo(executable, command.ToString());
            start.WorkingDirectory = target;
            start.UseShellExecute = false;
            using (Process child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, PortableInfo.Name + " could not open", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(character); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
}
