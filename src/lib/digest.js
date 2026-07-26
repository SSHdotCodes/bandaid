'use strict';

const { approxTokenCount, truncateMiddleWithTokenBudget } = require('./tokens');

/**
 * Turn digests.
 *
 * Codex summarizes a turn *with the turn itself* — tool call params and tool
 * results included — rather than reducing it to prose. Claude Code's native
 * summary keeps the narrative and drops the mechanics, which is why a compacted
 * Claude session forgets which file it had open and what the last grep found.
 *
 * A digest is the mechanical record: for each tool call in a turn, what was
 * called, with which arguments that mattered, and what came back.
 */

const MAX_LABEL_LEN = 400;

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    // Tool responses commonly arrive as content blocks.
    const parts = [];
    for (const item of value) {
      if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
      else parts.push(asText(item));
    }
    return parts.filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.stdout === 'string' || typeof value.stderr === 'string') {
      return [value.stdout, value.stderr].filter(Boolean).join('\n');
    }
    if (Array.isArray(value.content)) return asText(value.content);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function clampLabel(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LABEL_LEN ? `${flat.slice(0, MAX_LABEL_LEN)}…` : flat;
}

/**
 * The identifying arguments of a call, in the form a human would recognize it.
 * Falls back to compact JSON for tools we do not know about, including MCP.
 */
function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return clampLabel(asText(input));

  const pick = (...keys) => {
    for (const key of keys) {
      if (typeof input[key] === 'string' && input[key]) return input[key];
    }
    return null;
  };

  switch (toolName) {
    case 'Bash':
    case 'BashOutput': {
      const cmd = pick('command') || '';
      const desc = pick('description');
      return clampLabel(desc ? `${cmd}  # ${desc}` : cmd);
    }
    case 'Read':
    case 'Write': {
      const file = pick('file_path', 'notebook_path') || '';
      const range = input.offset != null || input.limit != null ? ` (offset=${input.offset ?? 0}, limit=${input.limit ?? '-'})` : '';
      return clampLabel(file + range);
    }
    case 'Edit':
    case 'NotebookEdit': {
      const file = pick('file_path', 'notebook_path') || '';
      const old = pick('old_string');
      return clampLabel(old ? `${file} :: ${old.split('\n')[0]}` : file);
    }
    case 'Grep': {
      const pattern = pick('pattern') || '';
      const where = pick('path', 'glob');
      return clampLabel(where ? `/${pattern}/ in ${where}` : `/${pattern}/`);
    }
    case 'Glob':
      return clampLabel([pick('pattern'), pick('path')].filter(Boolean).join(' in '));
    case 'WebFetch':
      return clampLabel([pick('url'), pick('prompt')].filter(Boolean).join(' — '));
    case 'WebSearch':
      return clampLabel(pick('query') || '');
    case 'Task':
    case 'Agent':
      return clampLabel([pick('subagent_type'), pick('description')].filter(Boolean).join(': '));
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      return clampLabel(todos.map((t) => `[${t.status || '?'}] ${t.content || t.activeForm || ''}`).join(' | '));
    }
    default:
      try {
        return clampLabel(JSON.stringify(input));
      } catch {
        return clampLabel(asText(input));
      }
  }
}

function looksLikeFailure(responseText) {
  const head = responseText.slice(0, 200).toLowerCase();
  return head.includes('error:') || head.startsWith('error') || head.includes('exit code 1') || head.includes('traceback');
}

/** Build the stored record for one resolved batch of tool calls. */
function buildCallRecords(toolCalls, { toolInputMaxTokens, toolResultMaxTokens }) {
  const calls = [];
  for (const call of toolCalls || []) {
    if (!call || typeof call !== 'object') continue;
    const name = call.tool_name || call.toolName || 'unknown';
    const rawInput = summarizeToolInput(name, call.tool_input ?? call.toolInput);
    const rawResult = asText(call.tool_response ?? call.toolResponse ?? call.tool_result);

    const input = truncateMiddleWithTokenBudget(rawInput, toolInputMaxTokens).text;
    const result = truncateMiddleWithTokenBudget(rawResult, toolResultMaxTokens).text;

    calls.push({
      name,
      input,
      result,
      failed: looksLikeFailure(rawResult),
    });
  }
  return calls;
}

function renderCall(call, index) {
  const status = call.failed ? ' [FAILED]' : '';
  const lines = [`  ${index + 1}. ${call.name}${status}`];
  if (call.input) lines.push(`     args: ${call.input}`);
  if (call.result) {
    const indented = call.result
      .split('\n')
      .map((line) => `     | ${line}`)
      .join('\n');
    lines.push(`     result:\n${indented}`);
  }
  return lines.join('\n');
}

/**
 * Render one turn's batches into a single digest block, middle-truncated to
 * `maxTokens` — Codex's ~20k-per-turn chunking.
 */
function renderTurnDigest(turn, { maxTokens }) {
  const calls = turn.batches.flatMap((batch) => batch.calls || []);
  if (!calls.length) return null;

  const header = `--- turn ${turn.turnIndex} — ${calls.length} tool call${calls.length === 1 ? '' : 's'} ---`;
  const promptLine = turn.promptPreview ? `  user asked: ${turn.promptPreview}` : null;
  const body = [header, promptLine, ...calls.map(renderCall)].filter(Boolean).join('\n');

  const { text, originalTokens } = truncateMiddleWithTokenBudget(body, maxTokens);
  return { turnIndex: turn.turnIndex, text, tokens: approxTokenCount(text), truncatedFrom: originalTokens };
}

/** Group flat batch records into per-turn buckets, oldest first. */
function groupBatchesByTurn(batches, prompts) {
  const byTurn = new Map();
  for (const batch of batches) {
    const turnIndex = Number.isFinite(batch.turnIndex) ? batch.turnIndex : 0;
    if (!byTurn.has(turnIndex)) byTurn.set(turnIndex, { turnIndex, batches: [], promptPreview: null });
    byTurn.get(turnIndex).batches.push(batch);
  }

  for (const turn of byTurn.values()) {
    const prompt = prompts[turn.turnIndex - 1];
    if (prompt?.text) turn.promptPreview = clampLabel(prompt.text);
  }

  return [...byTurn.values()].sort((a, b) => a.turnIndex - b.turnIndex);
}

module.exports = {
  asText,
  buildCallRecords,
  clampLabel,
  groupBatchesByTurn,
  renderTurnDigest,
  summarizeToolInput,
};
