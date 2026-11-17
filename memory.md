# Maple memory

This file holds lasting preferences, decisions, and ideas from conversations.
It is saved locally, but its contents are shared with GitHub Copilot when read
to provide conversation context. It is not model training or a full chat log.

## Preferences

- The user likes Sol and wants to leave Maple's model setup unchanged for now.
- The user wants Maple to remember useful preferences and ideas across conversations.

## Ideas for later

- Package Maple as a Windows desktop app that starts without a command prompt.
  Packaging approach is under discussion; not implemented.
- Explore connecting Maple to email and Teams notifications so Maple can alert
  the user to new messages. Proposed; not implemented.
- Explore connecting Maple to the user's work Copilot/Work IQ context through
  an organization-approved integration. Feasibility and access are unverified;
  not implemented.
- Add a model picker to Maple's system tray menu. Deferred; not implemented.
- Maple uses the supplied Maple-Animation-Pack WebPs for matching idle,
  greeting, thinking, listening, and reaction states at 1.5x playback speed.
  States without matching animations retain their PNG poses.
- The user is planning animation assets and wants a broad set of Maple reactions,
  including email and Teams alerts. Asset names and animation wiring are proposed.
- The user wants Maple to eventually act as a desktop frontend for their own
  internal Copilot "Autopilot" (an org-internal autonomous Copilot agent),
  once/if that Autopilot exposes MCP access. The idea: keep Maple's existing
  Electron UI (chat box, sprite, speech bubble) but point the backend at the
  Autopilot session instead of (or alongside) the plain Copilot CLI, so Maple
  becomes a custom "front door" into it. Blocked on: whether internal
  Autopilots will support MCP, and what the connection mechanism would be
  (CLI flag, API, MCP server exposed by Autopilot, etc.) — not yet announced
  as of this note. Not implemented; purely speculative/future work.

## Decisions

- Use this file for persistent conversation notes, rather than relying only on
  the current session's history.
