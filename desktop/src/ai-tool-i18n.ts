// Localization for tool names and todo statuses shown in the chat panel.
// Kept as a small standalone module (instead of expanding the global
// Translations interface) because the set of tool labels is large and
// only ever consumed by the AI capsule UI.

import { getLanguage } from './i18n';

type LangMap = { en: string; zh: string };

const TOOL_LABELS: Record<string, LangMap> = {
  run_command:         { en: 'Run Command',         zh: '运行命令' },
  read_terminal:       { en: 'Read Terminal',       zh: '读取终端' },
  read_screen:         { en: 'Read Screen',         zh: '读取屏幕' },
  watch_terminal:      { en: 'Watch Terminal',      zh: '监视终端' },
  type_text:           { en: 'Type Text',           zh: '输入文本' },
  press_keys:          { en: 'Press Keys',          zh: '按键操作' },
  read_file:           { en: 'Read File',           zh: '读取文件' },
  write_file:          { en: 'Write File',          zh: '写入文件' },
  list_files:          { en: 'List Files',          zh: '列出文件' },
  list_directory:      { en: 'List Directory',      zh: '列出目录' },
  search_files:        { en: 'Search Files',        zh: '搜索文件' },
  glob_search:         { en: 'Glob Search',         zh: '通配符搜索' },
  grep_search:         { en: 'Grep Search',         zh: '内容搜索' },
  upload_file:         { en: 'Upload File',         zh: '上传文件' },
  download_file:       { en: 'Download File',       zh: '下载文件' },
  web_search:          { en: 'Web Search',          zh: '网络搜索' },
  command_help:        { en: 'Command Help',        zh: '命令帮助' },
  wait_for_user_input: { en: 'Wait for Input',      zh: '等待输入' },
  todo_write:          { en: 'Update Plan',         zh: '更新计划' },
};

const TODO_STATUS: Record<'pending' | 'in_progress' | 'completed', LangMap> = {
  pending:     { en: 'pending',     zh: '待办' },
  in_progress: { en: 'in progress', zh: '进行中' },
  completed:   { en: 'completed',   zh: '已完成' },
};

const PLAN_LABELS = {
  title:    { en: 'Task plan', zh: '任务计划' },
  collapse: { en: 'Collapse',  zh: '折叠' },
  expand:   { en: 'Expand',    zh: '展开' },
  more:     { en: 'more items hidden', zh: '项已隐藏' },
};

/** Display label for a tool, falling back to the raw name when unmapped. */
export function toolDisplayName(toolName: string): string {
  const entry = TOOL_LABELS[toolName];
  if (!entry) return toolName;
  return entry[getLanguage()] ?? entry.en;
}

/** Localized status badge used by the persistent task plan rows. */
export function todoStatusLabel(status: 'pending' | 'in_progress' | 'completed'): string {
  const entry = TODO_STATUS[status];
  return entry[getLanguage()] ?? entry.en;
}

export function planTitle(): string { return PLAN_LABELS.title[getLanguage()] ?? PLAN_LABELS.title.en; }
export function planCollapseLabel(): string { return PLAN_LABELS.collapse[getLanguage()] ?? PLAN_LABELS.collapse.en; }
export function planExpandLabel(): string { return PLAN_LABELS.expand[getLanguage()] ?? PLAN_LABELS.expand.en; }
export function planMoreItemsLabel(n: number): string {
  const lang = getLanguage();
  return lang === 'zh'
    ? `还有 ${n} ${PLAN_LABELS.more.zh}`
    : `${n} ${PLAN_LABELS.more.en}`;
}

const WAIT_LABELS = {
  paused:    { en: 'Agent paused — please type in the terminal', zh: '已暂停 — 请在终端中输入' },
  received:  {
    en: '✓ Input received. Waiting for the command to finish — the agent will resume automatically.',
    zh: '✓ 已收到你的输入，等待命令执行完成 — Agent 会自动恢复。',
  },
  hint: {
    en: 'Type the input directly in the terminal below and press Enter. The agent will automatically resume when the command finishes. Timeout: {sec}s.',
    zh: '请直接在下方终端中输入并按 Enter 提交，命令完成后 Agent 会自动恢复。超时时间：{sec} 秒。',
  },
  cancelBtn:        { en: 'Cancel wait', zh: '取消等待' },
  cancellingBtn:    { en: 'Cancelling…', zh: '正在取消…' },
  autoDetected:     { en: 'Auto-detected password prompt', zh: '自动检测到密码输入提示' },
  autoDetectedFmt:  {
    en: 'Auto-detected password prompt: {line}',
    zh: '自动检测到密码输入提示：{line}',
  },
  resumed:   { en: 'resumed',   zh: '已恢复' },
  cancelled: { en: 'cancelled', zh: '已取消' },
  timeout:   { en: 'timed out', zh: '已超时' },
};

export function waitPausedLabel(): string {
  return WAIT_LABELS.paused[getLanguage()] ?? WAIT_LABELS.paused.en;
}
export function waitReceivedLabel(): string {
  return WAIT_LABELS.received[getLanguage()] ?? WAIT_LABELS.received.en;
}
export function waitHintLabel(timeoutSec: number): string {
  const tpl = WAIT_LABELS.hint[getLanguage()] ?? WAIT_LABELS.hint.en;
  return tpl.replace('{sec}', String(timeoutSec));
}
export function waitCancelBtnLabel(): string {
  return WAIT_LABELS.cancelBtn[getLanguage()] ?? WAIT_LABELS.cancelBtn.en;
}
export function waitCancellingBtnLabel(): string {
  return WAIT_LABELS.cancellingBtn[getLanguage()] ?? WAIT_LABELS.cancellingBtn.en;
}
export function waitAutoDetectedReason(detectorLine?: string): string {
  if (detectorLine) {
    const tpl = WAIT_LABELS.autoDetectedFmt[getLanguage()] ?? WAIT_LABELS.autoDetectedFmt.en;
    return tpl.replace('{line}', detectorLine.slice(0, 120));
  }
  return WAIT_LABELS.autoDetected[getLanguage()] ?? WAIT_LABELS.autoDetected.en;
}
export function waitResolvedLabel(status: 'completed' | 'aborted' | 'timeout' | string): string {
  const base = toolDisplayName('wait_for_user_input');
  const tail =
    status === 'completed' ? WAIT_LABELS.resumed[getLanguage()]
    : status === 'aborted' ? WAIT_LABELS.cancelled[getLanguage()]
    : status === 'timeout' ? WAIT_LABELS.timeout[getLanguage()]
    : status;
  return `${base} · ${tail ?? status}`;
}
