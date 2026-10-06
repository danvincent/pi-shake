# pi-shake

Context-shake plugin for [Pi](https://github.com/earendil-works/pi) — reduce context window usage by eliding old tool outputs and large code/XML blocks.

A Pi port of `opencode-shake`. Same pure elision core (tool results, fenced/XML blocks, images, protect windows, artifact recovery), wired to Pi extension points.

## Install

```bash
pi install ./pi-shake
```

Or copy the extension directly:

```bash
cp pi-shake/extensions/shake.ts ~/.pi/agent/extensions/
```

## How it works

### Auto mode (automatic, every LLM call)

The `context` handler shakes the message history before each model request using conservative settings:

- **protectTokens**: 32,000 — keeps recent context untouched
- **minSavings**: 1,000 — only shakes when meaningful savings are possible
- **fenceMinTokens**: 200 — only shakes large code blocks

No artifacts are written in auto mode. A transient notice is shown when a shake fires. The session transcript is never modified — the transform applies per request.

### Manual mode (`shake_context` tool + `/shake`)

The model can call `shake_context`, or you can run `/shake`, for aggressive reduction:

- **protectTokens**: 0 — everything is eligible (user overrides still apply)
- **minSavings**: 0 — even small outputs are shaken
- **fenceMinTokens**: 400

The tool dry-runs over branch history for counts, arms the aggressive shake for the next request, and the next `context` event writes originals to `.pi/.shake/` for recovery.

```
/shake        # aggressive elide
/shake both   # elide + images
/shake images # images only
```

## Configuration

Add a `shake` key to `.pi/settings.json` (or `opencode.json` for compat):

```json
{
  "shake": { "protectTokens": 8000, "minSavings": 500, "fenceMinTokens": 100 }
}
```

Invalid values fall back to defaults.

## What gets shaken

- **Tool results** → `[shaken ~N tokens]`
- **Code/XML blocks** → `[shaken <label> block ~N tokens]`
- **Images** → `[image removed]` (manual `images`/`both` modes only)

Never shaken: `ask`/`question`/`todo` results, `AGENTS.md`/`.opencode/`/`.pi/`/`skill://` reads, errors, already-shaken placeholders, recent context inside the protect window, system prompts, thinking blocks.

## Artifact recovery

Manual shakes save originals to `.pi/.shake/shake-<session>-<timestamp>.md`, linked from placeholders as `recover: <path>#region-N`.

## License

MIT
