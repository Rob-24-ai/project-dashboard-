# Tower

**Tower** is a small floating dashboard for macOS. It shows every Claude and
Codex desktop conversation you have going, which ones are working, which ones
finished, and which ones are waiting on you. Add your own project list and it
groups those conversations under each project, with your notes and next steps
beside them.

It runs entirely on your Mac. It only reads the Claude and Codex apps' local
files; it never sends messages, changes their settings or stops their work.

## What you need

- macOS 12 or newer
- [Node.js](https://nodejs.org) **22.12 or newer** (includes npm). With
  Homebrew: `brew install node@22`
- Git
- The Claude desktop app and/or the Codex desktop app, signed in

## Install

Open Terminal and paste:

```sh
git clone https://github.com/Rob-24-ai/project-dashboard-.git
cd project-dashboard-
npm run setup
npm start
```

`npm run setup` needs internet access once. It installs the window's locked
dependencies (Electron) for your Mac's chip. `npm start` starts the local server
and opens the floating window.

After that, double-click **Start Tower.command** in the folder to open Tower
again. If macOS blocks it the first time, right-click it and choose **Open**, or
run `npm start` from the folder instead. Keep the whole folder together.

The first run takes a baseline, so old finished conversations don't flood the
window. Open or resume a conversation to see it appear and change status.

## Using the window

- The window **floats above other apps** and stays visible on every desktop and
  over full-screen apps. The pin button in its title bar turns that off and on.
- The desk-shaped **menu-bar icon** has Show Tower, Hide Tower and Quit Tower.
  Closing the window only hides it.
- The same dashboard is at http://127.0.0.1:4433 in any browser on this Mac.
- Chat states: **Working**, **Finished for now** (the assistant's turn ended;
  not proof the work is done), **Needs you** (a question or permission request),
  and **Status unclear**.
- Each chat title has a small **copy icon** beside it that copies the full title.
- **Keep for later** and **Dismiss** only change Tower's own view. They never
  close or archive anything in Claude or Codex.
- Soft sounds play when a chat needs you or a working chat finishes. Each can be
  muted from the dashboard.

## Add your projects

Without a project file, Tower shows a plain list of conversations. To group them
by project, you make a `project-board.json` file listing your projects and which
conversations belong to each.

### 1. Make your project file

In Terminal, from the `project-dashboard-` folder:

```sh
cp project-board.example.json project-board.json
open -e project-board.json
```

That opens it in TextEdit. Replace the two example projects with your own.
Each project has:

| Field | What it is |
| --- | --- |
| `id` | Short unique name: lowercase letters, numbers and dashes |
| `title` | What the column shows |
| `stage` | One of `live`, `built`, `prog` (in progress), `wait` (waiting on me), `pause`, `stuck`, `park` |
| `freshness` | When you last checked the notes, for example `"Checked Oct 30"` |
| `description` | Optional one-line summary |
| `notes` | List of `{ "status": <a stage>, "text": "..." }` |
| `next` | Optional next step |
| `sessionIds` | The conversations that belong to this project (step 2) |

`source.updatedAt` at the top is required: any text saying when you last edited
the file. You can also add `source.title` and an `https://` link in `source.url`
to point at wherever you keep your master list.

### 2. Put your conversations into projects (copy and paste)

Tower needs each conversation's exact id. You don't need to dig for it: copy
the conversation's title, paste it into one command, and paste back what it
prints. Keep Tower running while you do this.

1. **Copy the chat's title.** Either:
   - **In Tower:** click the small copy icon right after the chat's title, or
   - **In the Claude or Codex app:** find the chat in the left sidebar and note
     its name. Tower uses the same names the apps show, so a few distinctive
     words are enough, for example `invoice script`.

2. **Paste it into this command** in Terminal, between the quotes:

   ```sh
   npm run sessions -- "PASTE THE TITLE HERE"
   ```

   It prints the matching conversations and a ready-made line at the end:

   ```
   id	app	title
   claude:local_6f1c2a90-...	Claude	Invoice script for monthly billing
   codex:019a3b7e-...	Codex	Invoice script tests

   Paste between the brackets of that project's "sessionIds": [ ]
   "claude:local_6f1c2a90-...", "codex:019a3b7e-..."
   ```

3. **Copy that last line** and paste it between the brackets of the project's
   `sessionIds` in `project-board.json`:

   ```json
   "sessionIds": ["claude:local_6f1c2a90-...", "codex:019a3b7e-..."]
   ```

   If it matched a chat you don't want, delete that one id (and its comma).
   Adding to a project that already has ids? Put a comma after the last one,
   then paste.

4. **Save the file.** Tower picks it up within a few seconds, no restart needed.
   If the file has a mistake, such as a missing comma, Tower shows a warning and
   keeps the plain list until you fix it.

Tips:

- `npm run sessions` with nothing after it lists every conversation, newest first.
- If a title has double quotes (`"`) in it, paste only a few words without them.
- A conversation can belong to only one project. Its sub-chats follow it
  automatically. Anything not assigned shows under **Other work**.
- New conversations get new ids. Add them the same way when you start one.

### How project needs work

A project at stage `wait` starts in **Needs me** at the top and stays there until
you choose **Later** or **Resolved** on it. When an assigned conversation asks you
something, its project jumps into Needs me too, and leaves once the chat stops
asking. Those choices are saved locally and survive restarts.

Your `project-board.json` stays on your Mac. Git ignores it.

## Start Tower at login (optional)

```sh
npm run install-service
```

This installs a login service (`~/Library/LaunchAgents/local.tower.dashboard.plist`)
that keeps the server running and restarts it after a reboot. Run it again after
moving the folder. If the new service doesn't answer within about 8 seconds, the
installer puts back the previous one and stops with an error. To remove it:

```sh
launchctl bootout gui/$(id -u)/local.tower.dashboard
rm ~/Library/LaunchAgents/local.tower.dashboard.plist
```

The service runs only the server. Open the window with **Start Tower.command**.

## Updating

```sh
git pull
npm run setup
```

Your project file, choices, window position and logs are not touched.

## Several Macs and your phone (optional)

Each Mac runs its own Tower. With [Tailscale](https://tailscale.com), each page
can also show the other Macs' conversations, and you can open it on your phone.
Conversations from another Mac are view-only.

1. Install Tailscale on every device and sign in with the same account. Don't
   use tagged devices.
2. In the Tailscale admin console, under DNS, turn on **MagicDNS** and
   **HTTPS Certificates**.
3. On each Mac, run exactly `tailscale serve --bg 4434`. `tailscale serve status`
   shows that Mac's `https://<machine>.<tailnet>.ts.net` address.
   **Use only that command.** Never use `--tcp` or `--tls-terminated-tcp`, never
   point serve at 4433, and never forward either port with `ssh -R` or `socat`.
   Port 4433 is this Mac's own page and its buttons.
4. On each Mac, copy `peers.example.json` to `peers.json` and edit it:
   - `label`: this Mac's short name
   - `tailnetHost`: this Mac's own Tailscale name
   - `allowedLogin`: your Tailscale login, for example `you@github`
   - `peers`: the other Macs' labels and `https://` addresses

   Restart Tower. A missing or invalid file keeps Tower local only, and the reason
   is written to `tower.log`.
5. On the phone, open a Mac's `https://...ts.net` address in Safari and choose
   **Share > Add to Home Screen**.

Your project notes and assignments never leave the Mac they're on, even with
Tailscale set up. A Mac that stops answering for more than 15 seconds is hidden,
with a line saying when it was last seen.

## What leaves your Mac

Without `peers.json`, nothing. Tower answers only on this Mac's own address
(127.0.0.1).

With `peers.json`, conversation titles, statuses, questions, recaps and their
dates become visible to your own devices on your Tailscale network, signed in as
the allowed login. Anything shaped like a file path is replaced with "a local
path". Two things to know:

- **Text is shown as written.** If you ever paste a password or key into a
  conversation, it could appear on your other devices' Tower page.
- **A Mac you connect is trusted.** If it were taken over, it could show a fake
  "Needs you" card. Every card from another Mac is labeled with that Mac's name
  and can only be viewed, never acted on.

Tower sends nothing to any other service and uses no AI model of its own.

## Troubleshooting

- **"Node.js 22.12 or newer is required"**: install Node 22 (`brew install node@22`)
  and make sure `node --version` shows it.
- **"Run npm run setup in the app folder first"**: run `npm run setup`.
- **"Tower is not answering on port 4433"** from `npm run sessions`: start Tower
  first with `npm start`.
- **Port 4433 is busy**: another program is using it. Tower won't stop it. Quit
  that program and try again.
- **A conversation is missing**: Tower lists recent desktop-app conversations.
  Terminal-only sessions and Codex's internal helper agents are left out.
- **Clicking a Claude card opens Claude but not that chat**: expected. Claude has
  no link to a specific chat, so pick it in the app. Codex cards open the exact chat.
- Logs are in `tower.log` in this folder.

## For developers

```sh
npm test
```

runs the server, page, project board, peer and launcher tests. These check the
plumbing, not the real desktop apps.

| File | Purpose |
| --- | --- |
| `server.js` | Local server: reads sessions, works out status, stores Tower's own state |
| `page.html` | The dashboard |
| `project-board.js` | Reads and validates `project-board.json`; project needs |
| `window/` | The floating Electron window |
| `scripts/start.js` | Launcher: starts the server if needed, opens the window |
| `scripts/list-sessions.js` | `npm run sessions` |
| `scripts/install-launch-agent.js` | `npm run install-service` |

Tower's own local files, all ignored by Git: `notifications.json` (tracked chats,
dismissals, project choices), `names.json`, `project-board.json`, `peers.json`,
`window/bounds.json` (window position) and `tower.log`. The `.gitignore` is an
allowlist, so add any new source file to it.

For tests, `TOWER_HOME`, `TOWER_DATA_DIR` and `TOWER_PORT` isolate inputs, state
and port. The launcher refuses to run with them set.

## License

MIT. See [LICENSE](LICENSE).
