#!/usr/bin/env node
/**
 * Tiny local MCP server exposing exactly three SAFE desktop actions for the
 * mascot's Copilot CLI session: opening a path in File Explorer, opening a
 * URL in the default browser, and committing/pushing THIS project's own
 * repo. Nothing else — no general shell, no arbitrary process launch.
 *
 * Safety notes:
 *  - open_path/open_url call `explorer.exe` directly via execFile (array
 *    argv, no cmd.exe / shell involved), so there is no shell-metacharacter
 *    injection surface the way `cmd /c start <url>` would have.
 *  - open_path requires the path to actually exist on disk.
 *  - open_url requires a strict http(s) URL (validated with the URL
 *    parser) — no file:, javascript:, or other schemes.
 *  - git_commit_and_push runs a FIXED sequence (add -A, commit -m <msg>,
 *    push origin <current-branch>) via execFile with array argv — the
 *    commit message is the only free-form input, and it's passed as a
 *    single argv element, so it can't inject extra git flags or escape
 *    into a shell. No flag the caller passes through (there are none) can
 *    ever become `--force`, `--hard`, etc. This exists specifically because
 *    Copilot's shell permission system can only allow/deny whole
 *    subcommands (e.g. "git push"), not individual flags — so granting
 *    raw `shell(git:*)` would have allowed `git push --force` and
 *    `git reset --hard` the moment plain `git push`/`git reset` were
 *    allowed. This tool is scoped so those are simply never reachable.
 *  - git_commit_and_push always runs with cwd pinned to THIS project's
 *    repo root (REPO_ROOT below) — it can never target any other
 *    directory or repository.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const REPO_ROOT = path.join(__dirname, '..', '..');

const server = new McpServer({ name: 'mascot-actions', version: '1.0.0' });

function openWithExplorer(target) {
  return new Promise((resolve, reject) => {
    execFile('explorer.exe', [target], (err) => {
      // explorer.exe frequently "fails" with a non-zero exit code even on
      // success (it's quirky about its own exit codes) — only treat actual
      // spawn failures (no such file) as real errors.
      if (err && err.code === 'ENOENT') return reject(err);
      resolve();
    });
  });
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: REPO_ROOT }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

server.registerTool(
  'open_path',
  {
    title: 'Open in File Explorer',
    description:
      'Opens a local file or folder on the user\'s computer in Windows File Explorer. ' +
      'The path must already exist.',
    inputSchema: {
      target: z.string().describe('Absolute path to a file or folder to open'),
    },
  },
  async ({ target }) => {
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) {
      return {
        content: [{ type: 'text', text: `Path does not exist: ${resolved}` }],
        isError: true,
      };
    }
    await openWithExplorer(resolved);
    return { content: [{ type: 'text', text: `Opened ${resolved} in File Explorer.` }] };
  }
);

server.registerTool(
  'open_url',
  {
    title: 'Open a webpage',
    description: "Opens a URL in the user's default web browser. Must be http:// or https://.",
    inputSchema: {
      url: z.string().describe('The http(s) URL to open'),
    },
  },
  async ({ url }) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { content: [{ type: 'text', text: `Not a valid URL: ${url}` }], isError: true };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        content: [{ type: 'text', text: `Only http:// and https:// URLs are allowed, got: ${parsed.protocol}` }],
        isError: true,
      };
    }
    await openWithExplorer(parsed.toString());
    return { content: [{ type: 'text', text: `Opened ${parsed.toString()} in the default browser.` }] };
  }
);

server.registerTool(
  'git_commit_and_push',
  {
    title: "Commit and push Maple's own code",
    description:
      "Stages all changes in Maple's own project folder, commits them with the given message, and pushes " +
      'to the current branch\'s "origin" remote. This is the ONLY way to save code changes to GitHub — there ' +
      'is no general git or shell access. Always operates on this project\'s own repository; never force-pushes, ' +
      'resets, or rewrites history. If there is nothing to commit, reports that instead of erroring.',
    inputSchema: {
      message: z.string().min(1).describe('A short, descriptive commit message for the staged changes'),
    },
  },
  async ({ message }) => {
    try {
      await runGit(['add', '-A']);

      // Nothing staged? `git diff --cached --quiet` exits 1 if there ARE
      // staged changes, 0 if there are none — report that cleanly instead
      // of letting `git commit` fail with its own error text.
      let hasStagedChanges = true;
      try {
        await runGit(['diff', '--cached', '--quiet']);
        hasStagedChanges = false;
      } catch (diffErr) {
        if (diffErr.code !== 1) throw diffErr;
      }
      if (!hasStagedChanges) {
        return { content: [{ type: 'text', text: 'Nothing to commit — no changes detected.' }] };
      }

      await runGit(['commit', '-m', message]);
      const { stdout: branchOut } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = branchOut.trim();
      await runGit(['push', 'origin', branch]);

      return {
        content: [{ type: 'text', text: `Committed and pushed to origin/${branch} with message: "${message}"` }],
      };
    } catch (err) {
      const detail = (err.stderr || err.stdout || err.message || String(err)).toString().trim();
      return { content: [{ type: 'text', text: `git_commit_and_push failed: ${detail}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
server.connect(transport);
