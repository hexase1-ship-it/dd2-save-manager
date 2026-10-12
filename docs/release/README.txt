DD2 Save Manager
================

A backup tool and save editor for Dragon's Dogma 2 (Steam, Windows).
Unofficial fan-made tool. Not affiliated with or endorsed by Capcom.

Languages: English, 한국어, 日本語, 简体中文, Español, Français
(the language menu is at the top right of the window).


HOW TO RUN

  1. Unzip the whole folder anywhere you like.
  2. Run DD2SaveManager.exe.

Nothing needs to be installed. The first time it starts, the program reads item names,
icons and skill lists from your own installed copy of the game; this takes a few seconds.
After a game update, use "Read game files again" (Edit > Items) to refresh them.

Requirements: Windows 10 or 11 (64-bit). The window uses the Microsoft Edge WebView2
runtime, which Windows 11 includes; without it the program opens in Edge or Chrome instead.


WHAT IT DOES

  Backups
    - Copies every file of your save folder, with a note, as often as you like.
    - Restores a backup. The saves as they were are backed up again first.

  Edit (pick a save, change values, then "Apply to save")
    - Gold and Rift Crystals. The game mode (Casual / Normal / Hard) is shown, not
      edited; change it from Options on the game's title screen.
    - Fast travel: mark the permanent portcrystals of the main map as found.
    - Arisen and main pawn: name, current vocation, level, experience, Discipline,
      growth values, vocation unlocks and experience.
    - Skills and augments: unlock weapon skills (including upgraded forms), core skills
      and augments, per vocation or all at once.
    - Main pawn: inclination, voice pitch, specialization, affinity; clear the
      dragonsplague of the main pawn and of support pawns in the party.
    - Items: counts, enhancement level, add and remove.
    - Appearance: save a character's look as a preset and put it on the Arisen or the
      main pawn; this also works for support pawns hired from other players. The
      "appearance sheet" lists a look as the numbers to enter in the game's own editor.


SAFETY

  - Close the game before applying changes or restoring; the program refuses while the
    game is running. Viewing and backing up work at any time.
  - Every apply and every restore first makes an automatic backup of the current saves.
  - Saves are tied to the Steam account that made them; another account's saves cannot
    be opened.
  - A save is only edited when the program can rebuild it byte for byte; otherwise it is
    opened read-only.
  - Steam Cloud keeps its own copy of your saves. If Steam asks which version to keep
    after you edit or restore, choose the local files.

  Use at your own risk. The program reads back every save it writes before replacing
  the old one, but not every kind of edit has been confirmed in the game itself. Some
  values were worked out from the save data and are marked as such in the program. Try a
  new kind of edit on its own first, and keep your backups.

  Jumping to portcrystals you have not reached, or unlocking things early, can skip parts
  of the story. Pawn data is shared online with other players; be considerate.


WHERE THINGS ARE KEPT

  Backups, appearance presets and what was read from the game are stored inside this
  folder (backups\, looks\, data\) when it can be written to, otherwise under
  %LOCALAPPDATA%\DD2SaveManager. Deleting the program folder deletes backups kept in it.
  The program never deletes a backup itself; "Move to trash" moves it to a _trash folder.

  The program runs entirely on your PC. It starts a small local server on 127.0.0.1 for
  its own window and sends nothing over the internet.


CREDITS AND LICENSES

  See the licenses\ folder: Node.js (runtime\node.exe), Microsoft Edge WebView2 (bin\),
  and CREDITS.txt for the research this tool builds on.

  The source is at https://github.com/hexase1-ship-it/dd2-save-manager and BUILD.txt says
  what every file here is and how to rebuild the exe from launcher\Launcher.cs.

  Dragon's Dogma 2 is a trademark of CAPCOM CO., LTD. This package contains no game
  assets; names and icons are read from your own copy of the game.
