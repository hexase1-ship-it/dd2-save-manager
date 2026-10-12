# DD2 Save Manager

A backup tool and save editor for Dragon's Dogma 2 (Steam, Windows). Unofficial fan-made tool, not affiliated with or endorsed by Capcom.

This repository is the source of the release published on Nexus Mods. If you only want to use the program, get the zip there, unzip it and run `DD2SaveManager.exe`.

## What it does

- **Backups**: copies the whole save folder with a note, and restores it later. Every restore and every edit backs up the current saves first.
- **Editing**: gold and Rift Crystals; the Arisen's and main pawn's name, vocation, level, experience, Discipline, growth values and vocation unlocks; weapon skills, core skills and augments; the main pawn's inclination, voice pitch, specialization and affinity; dragonsplague; the permanent portcrystals; item counts, enhancement, adding and removing items; appearance presets, and a sheet that lists a look as the numbers for the game's own character editor.
- The game mode (Casual, Normal, Hard) is shown, not edited.
- English, Korean, Japanese, Simplified Chinese, Spanish and French.

It runs entirely on your PC: a small local server on 127.0.0.1 and a window that shows its page. Nothing is sent over the internet. No game assets are in this repository or in the release; item names, icons and skill lists are read from your own installed copy of the game the first time the program runs.

## How it is put together

| Folder | What is in it |
|---|---|
| `src/` | The local server (`server.js`) and everything that reads and writes saves and game files. Plain JavaScript for Node.js, no dependencies. |
| `src/core/` | The save format: encryption (`mandarin.js`), container (`dsss.js`), object tree (`savetree.js`), where values live and how they may be edited (`gamedata.js`), appearance sheet (`looksheet.js`). |
| `src/gamefiles/` | Readers for the game's own files: archives, message files, data tables, textures. |
| `web/` | The page: plain HTML, CSS and JavaScript modules, no build step, no external resources. `web/lang/` holds the six languages. |
| `launcher/` | `Launcher.cs`, the C# source of `DD2SaveManager.exe` (a WinForms window hosting WebView2), with its build script. `launcher/webview2/` holds Microsoft's WebView2 SDK files it is built against. |
| `data/dd2/` | Layouts of the game data tables the tool reads, and enum names (see Credits). |
| `tools/` | `package.mjs` builds the release zip; the rest are development aids. |
| `test/` | `roundtrip.mjs` runs the whole read, edit, write, read-back cycle on a copy of a save folder. |
| `docs/` | The game's own terms in six languages, the design notes' source, and the text files that go into the release. |

## Build

Everything needed is Windows 10 or 11 (64-bit) and [Node.js](https://nodejs.org) 24.

**Run from source**

```
node src\server.js
```

This starts the server and opens the page in your browser.

**Build the exe**

```
launcher\build.bat
```

This compiles `launcher\Launcher.cs` into `DD2SaveManager.exe` with the C# compiler that ships with Windows (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, options in `launcher\build.rsp`) and copies the three WebView2 files from `launcher\webview2\` to `bin\`. Nothing else is compiled anywhere in the project.

**Build the release zip**

```
node tools\package.mjs --zip out.zip
```

This needs the game installed, because it starts the packaged copy once and has it read the game files as a test. The zip it makes contains:

- `src/`, `web/`, `data/dd2/`, `package.json` and `launcher/` as they are here;
- `DD2SaveManager.exe`, built from `launcher\Launcher.cs` during packaging;
- `bin\`: the three WebView2 files from `launcher\webview2\` (Microsoft.Web.WebView2 NuGet package 1.0.4022.49, unmodified);
- `runtime\node.exe`: the Node.js binary the tool was run with. The published release uses the official Node.js 24.18.0 win-x64 binary, SHA-256 `9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de`, the value listed on nodejs.org;
- the text files from `docs/release/` and the licenses.

**Test**

```
node test\roundtrip.mjs <a copy of your save folder> <your Steam account id>
```

Use a copy. The test never needs your real save folder.

## Safety notes

- Close the game before applying changes or restoring; the program refuses while the game is running.
- A save is only edited when the program can rebuild it byte for byte. Otherwise it is opened read-only.
- Not every kind of edit has been confirmed in the game itself. Some values were worked out from save data, and the program says so next to them. Keep your backups.

## Credits

The code here was written from scratch, on top of what these projects worked out and published:

- [MandarinJuice](https://github.com/mi5hmash/MandarinJuice) by mi5hmash: the save container and its encryption.
- [ree-save-editor](https://github.com/kvasszn/ree-save-editor) by kvasszn: the save tree format. The two files in `data/dd2/` are a small part of that project's type and enum dumps for Dragon's Dogma 2.
- [REE.PAK.Tool](https://github.com/Ekey/REE.PAK.Tool) by Ekey: the game's archive format.
- [REMSG_Converter](https://github.com/dtlnor/REMSG_Converter) by dtlnor: the message file format.
- The visual design started from the Linear entry of [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) (MIT); see `docs/design-source.md`.

Bundled with the release, each under its own license: Node.js, and the Microsoft Edge WebView2 SDK files (`launcher/webview2/LICENSE.txt`).

This project was built with the help of an AI coding assistant.

Dragon's Dogma 2 is a trademark of CAPCOM CO., LTD.
