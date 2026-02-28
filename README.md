# Pomotodo (Static HTML + JS)

A simple, offline-first Pomodoro + todo-style time tracker that runs entirely in your browser (no backend, no build tools).

## Features

- **Preset timers:** `25/5`, `30/5`, `45/10`, `60/10` (work/rest minutes)
- **Standard Pomodoro cycle:**
  - Work #1 → Short Rest
  - Work #2 → Short Rest
  - Work #3 → Short Rest
  - Work #4 → **20m Long Rest**
  - Then repeats with the next cycle
- **Pause / Resume** for the current ticking session
- **Work-end alarm sound** (beeps when a work session finishes)
- **Session history saved to browser storage** (`localStorage`)
- **CSV export** (detailed columns)
- **Resume after refresh / reopen**: active timer state is persisted and restored

## How to run

1. Open `index.html` in your browser.
2. Pick a preset.
3. Click **Start**.

No server is required.

## How it works

### Auto-advance
When a phase ends:

- When a **work** phase ends, the app **starts the next rest phase automatically** (short or long).
- When a **rest** phase ends, the timer **stops and waits** for you to click **Start**.

This matches: “once a session stops, wait for Start”, while still ensuring rest begins immediately after work completes.

### Work descriptions
When a **work** phase finishes, the app prompts you for a brief description of what you worked on.

- The **rest timer continues counting down** while the prompt is shown.
- If you leave it blank or skip, it is saved as: `working....`

### Controls
- **Start:** begins a new cycle at Work #1
- **Pause / Resume:** pauses or resumes the current phase
- **Reset:** stops the active timer and returns to idle (history is kept)
- **Clear History:** deletes all saved session records (asks for confirmation)
- **Export CSV:** downloads your stored sessions as a CSV file

## Data & privacy

All data stays in your browser using `localStorage`. Nothing is sent to any server.

### Storage keys

- `pomotodo:sessions:v1` — array of completed session records
- `pomotodo:active:v1` — active timer state (running/paused) for resume-on-reload
- `pomotodo:prefs:v1` — selected preset

### What counts as a “session” record?

Every completed phase is recorded:

- `work`
- `short_break`
- `long_break`

So you get a full timeline of work and rest time usage.

## CSV export format

The exported CSV is named like: `pomotodo-sessions-YYYY-MM-DD.csv`

Columns (in order):

1. `id`
2. `preset_key`
3. `cycle_number`
4. `work_index` (blank for `long_break`)
5. `type` (`work`, `short_break`, `long_break`)
6. `description` (work sessions only; blank for breaks)
7. `planned_seconds`
8. `actual_seconds`
9. `paused_seconds`
10. `started_at_iso`
11. `ended_at_iso`

Notes:
- Timestamps in CSV are **ISO-8601** (`Date.toISOString()`).
- The UI displays times in your **local timezone**.

## Alarm sound notes

Most browsers block audio until there has been a user gesture.

- The app initializes audio on your first click of **Start** / **Pause** / **Resume**.
- The alarm plays **only when a work phase ends** (not on break endings).

## Troubleshooting

- **Timer seems inaccurate in background tabs:** The app uses timestamps (not tick counting) to avoid drift and handles “catch up” on reopen.
- **No sound:** Ensure you interacted with the page (clicked a button) and your tab isn’t muted.
- **Storage errors:** If your browser storage is full, saving may fail. Use **Export CSV** and then **Clear History**.
