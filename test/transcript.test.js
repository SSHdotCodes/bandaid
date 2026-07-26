'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { readPromptsFromTranscript } = require('../src/lib/transcript');

function writeTranscript(entries) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-')), 'session.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
  return file;
}

describe('readPromptsFromTranscript', () => {
  it('keeps real prompts and drops tool results', () => {
    const file = writeTranscript([
      { type: 'user', timestamp: '1', promptSource: 'user', message: { content: 'first instruction' } },
      {
        type: 'user',
        timestamp: '2',
        toolUseResult: { ok: true },
        message: { content: [{ type: 'tool_result', content: 'file contents' }] },
      },
      { type: 'assistant', timestamp: '3', message: { content: [{ type: 'text', text: 'thinking' }] } },
      { type: 'user', timestamp: '4', message: { content: [{ type: 'text', text: 'second instruction' }] } },
    ]);

    const prompts = readPromptsFromTranscript(file);
    assert.deepEqual(prompts.map((p) => p.text), ['first instruction', 'second instruction']);
  });

  it('drops sidechain and meta entries', () => {
    const file = writeTranscript([
      { type: 'user', isSidechain: true, message: { content: 'subagent prompt' } },
      { type: 'user', isMeta: true, message: { content: 'system note' } },
      { type: 'user', message: { content: 'the real one' } },
    ]);
    assert.deepEqual(readPromptsFromTranscript(file).map((p) => p.text), ['the real one']);
  });

  it('drops a previous compaction summary rather than replaying it', () => {
    const file = writeTranscript([
      {
        type: 'user',
        message: { content: 'This session is being continued from a previous conversation that ran out of context.' },
      },
      { type: 'user', message: { content: 'carry on with the parser' } },
    ]);
    assert.deepEqual(readPromptsFromTranscript(file).map((p) => p.text), ['carry on with the parser']);
  });

  it('drops slash-command plumbing', () => {
    const file = writeTranscript([
      { type: 'user', message: { content: '<command-name>/status</command-name>' } },
      { type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } },
      { type: 'user', message: { content: 'a genuine instruction here' } },
    ]);
    assert.deepEqual(readPromptsFromTranscript(file).map((p) => p.text), ['a genuine instruction here']);
  });

  it('survives a torn final line and a missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-'));
    const file = path.join(dir, 'torn.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'kept' } })}\n{"type":"user","mess`);
    assert.deepEqual(readPromptsFromTranscript(file).map((p) => p.text), ['kept']);
    assert.deepEqual(readPromptsFromTranscript(path.join(dir, 'nope.jsonl')), []);
  });
});
