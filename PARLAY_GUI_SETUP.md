# Setting up the Parlay Entry tool (Windows)

This walks through everything needed to run the league's parlay entry
tool on a Windows PC that has nothing installed yet. It takes about
10–15 minutes. Follow the steps in order — later steps assume the
earlier ones worked.

You're installing three things: Python itself, a handful of small
add-on packages Python needs, and the tool's code (which lives in this
public GitHub repo, free to download).

## Step 1 — Install Python

1. Open a browser and go to **https://www.python.org/downloads/**
2. Click the yellow **"Download Python 3.x.x"** button (it automatically
   offers the right version for Windows).
3. Open the downloaded installer file.
4. **Important:** on the very first screen, check the box at the bottom
   that says **"Add python.exe to PATH"** before clicking anything else.
   If you skip this, nothing in the later steps will work.
5. Click **"Install Now"** and let it finish, then click **"Close"**.

## Step 2 — Confirm Python installed correctly

1. Press the **Windows key**, type `cmd`, and press **Enter**. This
   opens a black window called Command Prompt.
2. Type:
   ```
   python --version
   ```
   and press Enter.
3. You should see something like `Python 3.12.4`. If instead you get an
   error, or it opens the Microsoft Store, Python isn't set up correctly
   — reinstall it and make sure to check "Add python.exe to PATH" in
   Step 1.

## Step 3 — Download the tool's code

1. In your browser, go to:
   **https://github.com/bradbutcher321/RetirementLeague**
2. Click the green **"Code"** button, then click **"Download ZIP"**.
3. Find the downloaded file (usually in your **Downloads** folder),
   named `RetirementLeague-main.zip`.
4. Right-click it and choose **"Extract All..."**, then click
   **"Extract"**. This creates a folder named `RetirementLeague-main`.
5. Move that folder somewhere easy to find — your Desktop or Documents
   both work fine.

## Step 4 — Install the required packages

1. Back in Command Prompt (open a new one if you closed it: Windows
   key, type `cmd`, Enter).
2. Navigate into the folder from Step 3. If you put it on your Desktop,
   type:
   ```
   cd Desktop\RetirementLeague-main
   ```
   (adjust this if you moved it somewhere else).
3. Type:
   ```
   pip install -r requirements.txt
   ```
   and press Enter. This installs everything the tool needs (`gspread`,
   `google-auth`, `customtkinter`, `tzdata`). It may take a minute or
   two — you'll see several packages download.

## Step 5 — Get the credentials file from Brad

The tool needs one small file, **`google_secret.json`**, to read and
write the league's Google Sheet. This file works like a password, so:

- **Don't** send/receive it over plain email or text.
- Get it from Brad through a secure channel (a password manager's
  secure-share feature, an encrypted file transfer, etc.) — ask him
  which he'd prefer.
- Once you have it, put `google_secret.json` directly inside the
  `RetirementLeague-main` folder — the same folder that has
  `parlay_gui.py` in it.

## Step 6 — Run the tool

You now have two ways to launch it:

**Easiest — double-click:**
In the `RetirementLeague-main` folder, double-click **`run_parlay_gui.bat`**.
A window titled "Retirement League Parlay Entry" should open after a
few seconds.

**Or from Command Prompt** (useful if something goes wrong and you want
to see any error messages):
1. In Command Prompt, make sure you're still in the
   `RetirementLeague-main` folder (same `cd` step as Step 4).
2. Type:
   ```
   python parlay_gui.py
   ```
   and press Enter.

Either way, the first time you run it you'll see "Connecting to Google
Sheets..." for a couple seconds before the real window appears.

## Troubleshooting

| Problem | Likely cause / fix |
|---|---|
| `'python' is not recognized as an internal or external command` | Python wasn't added to PATH during install (Step 1) — reinstall Python and check that box. |
| `No module named 'gspread'` (or `customtkinter`, etc.) | Step 4 didn't complete — re-run `pip install -r requirements.txt` from inside the `RetirementLeague-main` folder. |
| App opens but immediately shows "Failed to connect: ..." | `google_secret.json` is missing, misnamed, or not in the same folder as `parlay_gui.py` — double check Step 5. |
| Double-clicking `run_parlay_gui.bat` flashes a black window and closes instantly | Run it from Command Prompt instead (Step 6, second option) so the error message stays visible instead of closing with the window. |

If none of that fixes it, send Brad whatever error text is showing —
it'll usually point straight at which step to redo.
