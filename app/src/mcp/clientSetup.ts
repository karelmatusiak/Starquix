import { t } from '@/i18n';

// The prompt AI Settings → MCP gives the user to paste into their coding agent
// (Claude Code, Cursor, Codex — anything with a shell). It drives the relay
// CLI directly (no agent restart) with the editor's code, so the relay adopts
// it (mcp/src/cli.ts adoptCode) and the light turns green; its last step asks
// the agent to register the same command in its own MCP settings.

/** desktop/src/preload.cjs `sqDesktop.mcp`: the app-wide relay code (no pasted
 *  code — the relay loads the same ~/.starquix-mcp/daemon.json,
 *  desktop/src/agents.mjs). null outside the desktop app. */
export interface DesktopMcp {
  code: () => Promise<string>;
  rotate: () => Promise<string>;
  onCode: (cb: (code: string) => void) => () => void;
}
export function desktopMcp(): DesktopMcp | null {
  return (globalThis as { sqDesktop?: { mcp?: DesktopMcp } }).sqDesktop?.mcp ?? null;
}

/** How the agent launches the relay: the desktop app's bundled copy, run on
 *  the app's own runtime (desktop/src/main.mjs mcpCommand — no npm package,
 *  no Node install); on a dev server this checkout's build (vite.config
 *  VITE_SQ_MCP_BIN); else the npm package name. Read per call so tests can stub. */
function relayCommand(): string {
  const desktop = (globalThis as { sqDesktop?: { mcpCommand?: string | null } }).sqDesktop?.mcpCommand;
  if (desktop) return desktop; // the launcher ~/.starquix-mcp/bin/starquix-mcp
  const bin = import.meta.env.VITE_SQ_MCP_BIN as string | undefined;
  return bin ? `node "${bin}"` : 'npx -y starquix-mcp';
}

/** Windows desktop (desktop/src/agents.mjs server): the relay as an MCP config runs it — the app's runtime + script + env.
 *  Agents spawn an .exe; the .cmd launcher (`sq`) runs only through a shell. null elsewhere. */
function relayServer(): { command: string; args: string[]; env: Record<string, string> } | null {
  return (globalThis as { sqDesktop?: { mcpServer?: { command: string; args: string[]; env: Record<string, string> } | null } }).sqDesktop?.mcpServer ?? null;
}

export function mcpAgentPrompt(code: string): string {
  const server = relayServer();
  return [
    t('Connect to my Starquix editor and make changes in it.'),
    `sq = ${relayCommand()}`,
    `1. sq pair --code ${code}`,
    '2. sq call get_project — follow the designGuide it returns for everything you create.',
    "3. sq tools lists the tools; sq call <tool> '<json args>' makes changes.",
    server
      ? `4. Optional, for native tools from your next chat on: add a stdio MCP server named "starquix" to your own MCP settings: ${JSON.stringify(server)}`
      : `4. Optional, for native tools from your next chat on: add a stdio MCP server named "starquix" to your own MCP settings that runs ${relayCommand()} (no arguments).`,
  ].join('\n');
}
