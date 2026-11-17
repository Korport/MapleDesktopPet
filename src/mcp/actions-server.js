#!/usr/bin/env node
/**
 * Tiny local MCP server exposing exactly two SAFE desktop actions for the
 * mascot's Copilot CLI session: opening a path in File Explorer, and
 * opening a URL in the default browser. Nothing else — no general shell,
 * no arbitrary process launch.
 *
 * Safety notes:
 *  - Both tools call `explorer.exe` directly via execFile (array argv, no
 *    cmd.exe / shell involved), so there is no shell-metacharacter
 *    injection surface the way `cmd /c start <url>` would have.
 *  - open_path requires the path to actually exist on disk.
 *  - open_url requires a strict http(s) URL (validated with the URL
 *    parser) — no file:, javascript:, or other schemes.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

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

const transport = new StdioServerTransport();
server.connect(transport);
