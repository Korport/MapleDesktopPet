# Maple memory

This file holds lasting preferences, decisions, and ideas from conversations.
It is saved locally, but its contents are shared with GitHub Copilot when read
to provide conversation context. It is not model training or a full chat log.

## Preferences

- The user likes Sol and wants to leave Maple's model setup unchanged for now.
- The user wants Maple to remember useful preferences and ideas across conversations.
- The user wants visually polished documents and presentations with modern,
  varied styles, rather than plain title-and-bullet layouts.
- The user wants terminal-like detail in Maple's live activity, including
  tool calls, results, progress, and exposed reasoning summaries.
- The user wants unused AWS publishing dependencies, including `aws4`, removed
  cleanly from Maple's build tooling. Implemented 2026-11-19.

## Ideas for later

- Package Maple as a Windows desktop app that starts without a command prompt.
  Packaging approach is under discussion; not implemented.
- Explore connecting Maple to the user's work Copilot/Work IQ context through
  an organization-approved integration. Feasibility and access are unverified;
  not implemented.
- Explore connecting Maple to Microsoft Copilot Cowork to create PowerPoint
  presentations and Word documents. Preferred workflow: Maple researches and
  supplies an outline/design brief; Cowork produces the polished file.
  Research on 2026-11-18 found documented Cowork skills and outbound MCP
  connectors, but no verified public API to start Cowork tasks from Maple.
  Microsoft 365 Copilot Chat API explicitly excludes file-creation skills.
  Manual brief handoff is feasible; a custom connector would require approved
  hosting/authentication and initiation in Cowork. Not implemented.
- Add a model picker to Maple's system tray menu. Deferred; not implemented.
- Upgrade document creation with curated themes, varied layouts, visuals and
  rendered-preview quality checks. Proposed; not implemented.
- Maple uses the supplied Maple-Animation-Pack WebPs for matching idle,
  greeting, thinking, listening, and reaction states at 1.5x playback speed.
  The 13 Maple-Extra-Animations WebPs now replace the remaining static poses:
  talking, yawning, sleeping, stretching, concerned, surprised, loving,
  laughing, shy, proud, sad, goodbye, and startled/dragged, also at 1.5x.
- The user is planning animation assets and wants a broad set of Maple reactions,
  including email and Teams alerts. Notification reactions are now wired to
  the supplied email/Teams animations; more reactions remain proposed.
- The user likes Maple's current animations and wants to create more to replace
  static PNG poses. Both supplied animation packs are now connected.
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
- Maple's `electron-builder` devDependency transitively declares `aws4`
  (via `electron-publish`'s S3/Spaces auto-publish code path, which Maple
  never configures or uses — confirmed no installed electron-builder package
  actually imports it). An npm `overrides` entry in package.json resolves
  `aws4` to a local no-op stub at `vendor/aws4-stub` instead of installing
  the real package, so `node_modules/aws4` no longer exists. The stub's
  `sign()` throws a clear error if ever actually called. Packaging
  (`npm run dist`/`dist:dir`) was verified to still work after the swap.
- Maple can create local PowerPoint (.pptx), Word (.docx), and Excel (.xlsx)
  files through create_office_file, saved with unique names in Documents\Maple.
  Implemented without Office or Cowork; supports text slides, document sections
  and tables, and spreadsheet values. Existing-file editing, images, charts,
  templates, and work-data integrations are not implemented.
- Maple has a read-only live activity window, opened from the tray menu or
  Alt+Shift+L. It streams GitHub Copilot JSONL events, including tool calls,
  results, progress, diagnostics, and any exposed reasoning summaries, while
  keeping only the final assistant message in chat. Recent output is bounded
  and held in memory; it is not an interactive terminal, cannot expose private
  internal reasoning, and cannot show output that the CLI does not emit.
- Live activity has a Download activity log button for saving the current
  in-memory output as a UTF-8 text file through a Save dialog. Logs are not
  saved automatically or restored across restarts, as the user prefers.
- While Maple works, a compact scrolling text bubble above her head shows
  streamed progress, tool status, and reasoning summaries when emitted by
  GitHub Copilot. It is replaced by the final reply on completion or error.
  It does not expose private internal reasoning. Implemented.
- The activity window tracks the current Maple session's cumulative input,
  output, cache, and reasoning tokens, plus reported AI-credit cost and premium
  requests. Totals refresh after each reply using GitHub Copilot's usage export,
  include subagents, and reset when Maple restarts. Missing/partial usage is
  labeled; billing units are not dollar estimates or an invoice. Implemented.
- The user approved privacy-first Outlook and Teams notifications. Maple now
  has a tray connection screen using tenant-specific Microsoft device sign-in,
  with generic Inbox email and Teams chat alerts and matching animations.
  Requires an organization-approved Entra public-client app and user sign-in;
  no account is preconnected and live tenant access is unverified.
  Polls about once a minute; Teams uses latest-chat previews, not channels or
  guaranteed per-message delivery. Message text is not sent to GitHub Copilot.
  Credentials stay in memory; reconnect after restart.
  Device sign-in uses a fixed Microsoft browser URL rather than trusting or
  requiring an exact response URL, defaults an omitted polling interval to
  five seconds, and names malformed fields without logging response values.
