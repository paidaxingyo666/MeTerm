// ─── AI Agent Tool System (Facade) ──────────────────────────────
// Tool registry and built-in tool implementations for the Terminal Agent.
// The implementation is split across multiple files for maintainability:
//   - ai-tools-core.ts     : types, registry, danger detection, utilities
//   - ai-tools-shell.ts    : shell hook injection + command executor
//   - ai-tools-command.ts  : run_command / read_terminal / type_text / press_keys / watch_terminal / wait_for_user_input / read_screen
//   - ai-tools-file.ts     : read_file / write_file
//   - ai-tools-meta.ts     : web_search / command_help
// This file remains the public entry point — it only re-exports and
// assembles the default ToolRegistry via initializeTools().

import { loadSettings } from './themes';

// ── Public re-exports ──────────────────────────────────────────
export type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolHandler,
  ToolOutputWithImages,
} from './ai-tools-core';
export type { TodoItem, TodoStatus, TodoStateRef } from './ai-tools-todo';
export { TodoState } from './ai-tools-todo';
export {
  ToolRegistry,
  TOKEN_BUDGET,
  stripAnsi,
  truncateOutput,
  isDangerousCommand,
  isExtremelyDangerous,
  watchForUserInput,
  setShellType,
  getShellType,
  buildToolContext,
} from './ai-tools-core';
export { injectShellHook } from './ai-tools-shell';

// ── Internal imports for initializeTools ──────────────────────
import { ToolRegistry } from './ai-tools-core';
import {
  createRunCommandTool,
  createReadTerminalTool,
  createTypeTextTool,
  createPressKeysTool,
  createWatchTerminalTool,
  createWaitForUserInputTool,
  createReadScreenTool,
} from './ai-tools-command';
import { createReadFileTool, createWriteFileTool } from './ai-tools-file';
import { createWebSearchTool, createCommandHelpTool } from './ai-tools-meta';
import { createTodoWriteTool } from './ai-tools-todo';
import { createUploadFileTool, createDownloadFileTool } from './ai-tools-transfer';
import {
  createListDirectoryTool,
  createGlobSearchTool,
  createGrepSearchTool,
} from './ai-tools-search';

// ─── Initialize ──────────────────────────────────────────────────

export function initializeTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createRunCommandTool());
  registry.register(createReadTerminalTool());
  registry.register(createReadScreenTool());
  registry.register(createTypeTextTool());
  registry.register(createPressKeysTool());
  registry.register(createWatchTerminalTool());
  registry.register(createWaitForUserInputTool());
  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());
  // Task planning + transfer + structured search
  registry.register(createTodoWriteTool());
  registry.register(createUploadFileTool());
  registry.register(createDownloadFileTool());
  registry.register(createListDirectoryTool());
  registry.register(createGlobSearchTool());
  registry.register(createGrepSearchTool());

  // Conditionally register command_help if tldr is enabled
  syncCommandHelpTool(registry);

  // Conditionally register web search if SearXNG is configured
  syncWebSearchTool(registry);

  return registry;
}

/** Sync web_search tool registration with current settings. */
export function syncWebSearchTool(registry: ToolRegistry): void {
  const settings = loadSettings();
  if (settings.searxngEnabled && settings.searxngUrl) {
    if (!registry.has('web_search')) {
      registry.register(createWebSearchTool());
    }
  } else {
    registry.unregister('web_search');
  }
}

/** Sync command_help tool registration with current settings. */
export function syncCommandHelpTool(registry: ToolRegistry): void {
  const settings = loadSettings();
  if (settings.tldrEnabled) {
    if (!registry.has('command_help')) {
      registry.register(createCommandHelpTool());
    }
  } else {
    registry.unregister('command_help');
  }
}
