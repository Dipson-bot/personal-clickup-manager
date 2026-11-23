# ClickUp Tracker changelog

## 0.4.9
- Read from WordPress through this app (for your other Chrome profile) now brings back each site's WordPress version too, not only the PHP version.
- Menu fixes: choices show straight away in the menu-bar / tray menu, and times listed in the menu are on the hour and half hour in every time zone.

## 0.4.8
- On the taskbar: drag the strip onto another monitor's taskbar and it stays there (it used to jump back to the main screen). If that monitor is unplugged, it goes back to the main screen.
- Move off the taskbar no longer leaves the floating window somewhere off-screen (an old place on a monitor that isn't there): it opens in the corner instead. The tray menu also has Bring it back to the main screen's corner.
- No more black box above the strip on computers that can't draw see-through windows (an older graphics driver, remote desktop): the hover card then opens by growing the strip. If a black box still shows, untick See-through hover card in the tray menu.
- The hover card stays in front while you read it: a tooltip or another always-on-top window no longer covers it after a moment.
- ✓ Done and ✓ Today don't complete a task whose File: "" has no link yet (attach the file or paste its link in ClickUp first).

## 0.4.7
- Starting a task (▶ Start, Resume last) for a client with a live No site changes or Work paused notice in the extension asks first.
- Sync everything works the same on Windows and Mac: a Mac file name with a character Windows refuses (such as :) is saved under a name Windows accepts and stays one file; the same file in another upper / lower case or with accents stored the Mac way is no longer copied twice; a file open in another program (Word, say) is simply tried again next time, with no temporary file left behind; Office's own temp files (~WRL….tmp) and the Mac's hidden Icon file are skipped.
- Mac: the menu-bar menu has ⤢ Bigger view (note, comments, files) while a timer runs, even when the floating strip is hidden - the window hides again when you close it.

## 0.4.6
- New ✓ Today button on the hover card (and the bigger view and ▾ menu): completes the task, stops the timer and sets its due date to today - the day it was really finished.
- The hover card's top line shows the task and its client side by side ("Task name… | Client…", the whole of each on hover), so the line below has room for the due date.
- The extension's "Sync everything with my other computers" can now copy your client folders both ways (it reads and writes them through this app, inside the client folders only, keeping each file's date).

## 0.4.5
- Mac: no more "ClickUp Tracker tried to access your data from other apps" warning. To install new versions of the extension for you, the app used to look up the extension's folder in your browsers' settings files, which newer macOS blocks. Now you choose that folder once (it asks when an update arrives, or tray menu › Choose the extension folder for updates), and it is remembered. Windows works as before.

## 0.4.4
- Mac: the time in the menu bar can count the seconds too - tray menu › Show seconds in the menu bar (off at first). It is counted on the Mac from when the timer started, so it adds no calls to ClickUp, and the digits keep the same width so the menu bar does not jiggle.
- Mac: choose what the menu bar shows - tray menu › Menu bar shows › This task and today (as before), This task only, or Today only - for menu bars that are short on room.

## 0.4.3
- Tells the extension which task it sees tracking, so a timer started here or in ClickUp shows on the extension's pages within a minute.
- Safer link with the extension: only Personal ClickUp Manager (the extension this app was set up with, and any you allow) can talk to the app. Any other browser extension that tries gets an Allow / Don't allow question first.

## 0.4.2
- Helps the extension read PHP versions from WordPress when the WordPress sign-ins are in a different Chrome profile: a copy of the extension in that profile picks up the list of sites through this app and hands back only the versions. Only site addresses and version numbers pass through, on this computer only.

## 0.4.1
- The extension can move the files it copied from Slack into a client folder earlier to the Recycle Bin (Trash on Mac) when you ask it to (Clients › Slack › Move to Recycle Bin). Only those files, by exact name, directly in that client's folder, and they can still be restored.

## 0.3.2
- The strip shows this task's time today against its share for one day (its estimate over its working days: a 7h task for a week is 1h24 a day) next to today's total; the hover card adds the overall figure ("Overall 11h 39m / 7h · +4h 39m over").
- Fixed: the hover card could flicker, show squashed or stay open when the pointer moved on and off the strip quickly. It now opens after a short pause and always ends matching where the pointer is.

## 0.3.1
- ✓ Done asks first when the task has nothing to show for it yet (no Description: "…", no File: "…" and no comment) - Complete anyway or Cancel. Follows the extension's setting.

## 0.3.0
- The strip shows the task's time against its estimate AND today's total against your daily target, in the look you pick in the extension (General › Floating tracker › Strip style): batteries (default), Task | Today halves, two thin bars, two rings or edge lines - gently animated unless you switch that off. Its colour goes from light blue to green as you reach the estimate and to red past it, and the face moves with its mood.
- Point at the strip: a card opens just above it (below it if there's no room) with the task name, client and due date, and buttons - ⇄ Extra Task, Stop, Done; ↩ Back to task while on the Extra Task; Start Extra Task / Resume last / next tasks when no timer runs.
- New size "Slim strip" in the tray menu (the default). On a Mac the menu-bar title also shows today's total.

## 0.2.0
- Sits right in the Windows taskbar as a slim strip (task, time, Stop, Done; on a Mac the time is in the menu bar).
- One-click installer: no admin rights needed, starts straight away and with the computer from then on (turn it off in the tray menu).
- Signs in by itself through the Personal ClickUp Manager extension - no token to paste - and follows the extension's "Where the timer shows" setting (Taskbar, Both, Floating window or Neither).

## 0.1.0
- First version: always-on-top ClickUp timer window with the mood face, estimate bar and today's total; Stop / Done / ⇄ Extra / Back to task; comment with screenshots and files; bigger view with note and comments; new-comment badge; next tasks due today; tray menu with size, see-through level, daily target and start with the computer. Windows installer; macOS and Linux through the GitHub Action.
