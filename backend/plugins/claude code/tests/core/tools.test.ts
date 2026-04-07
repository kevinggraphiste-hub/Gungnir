import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFileTools, createSearchTools, createShellTools, createAllTools } from '../../src/core/tools.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'spearcode-tools-test-' + Date.now());

describe('File Tools', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('should read a file', async () => {
    await writeFile(join(TEST_DIR, 'test.txt'), 'hello world');
    const tools = createFileTools(TEST_DIR);
    const readTool = tools.find((t) => t.name === 'read_file')!;

    const result = await readTool.execute({ path: 'test.txt' });
    assert.ok(result.includes('hello world'));
  });

  it('should write a file', async () => {
    const tools = createFileTools(TEST_DIR);
    const writeTool = tools.find((t) => t.name === 'write_file')!;

    const result = await writeTool.execute({ path: 'new.txt', content: 'new content' });
    assert.ok(result.includes('Successfully wrote'));
  });

  it('should edit a file', async () => {
    await writeFile(join(TEST_DIR, 'edit.txt'), 'Hello World');
    const tools = createFileTools(TEST_DIR);
    const editTool = tools.find((t) => t.name === 'edit_file')!;

    const result = await editTool.execute({ path: 'edit.txt', old_string: 'World', new_string: 'SpearCode' });
    assert.ok(result.includes('Successfully edited'));
  });

  it('should list files', async () => {
    await writeFile(join(TEST_DIR, 'a.txt'), '');
    await writeFile(join(TEST_DIR, 'b.txt'), '');
    const tools = createFileTools(TEST_DIR);
    const listTool = tools.find((t) => t.name === 'list_files')!;

    const result = await listTool.execute({});
    assert.ok(result.includes('a.txt'));
    assert.ok(result.includes('b.txt'));
  });
});

describe('Search Tools', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('should find files with glob', async () => {
    await writeFile(join(TEST_DIR, 'test.ts'), '');
    await writeFile(join(TEST_DIR, 'test.js'), '');
    const tools = createSearchTools(TEST_DIR);
    const globTool = tools.find((t) => t.name === 'glob')!;

    const result = await globTool.execute({ pattern: '*.ts' });
    assert.ok(result.includes('test.ts'));
  });

  it('should grep file contents', async () => {
    await mkdir(join(TEST_DIR, 'search'), { recursive: true });
    await writeFile(join(TEST_DIR, 'search', 'search.txt'), 'foo bar baz\nhello world\nfoo again');
    const tools = createSearchTools(join(TEST_DIR, 'search'));
    const grepTool = tools.find((t) => t.name === 'grep')!;

    const result = await grepTool.execute({ pattern: 'foo', include: '*.txt' });
    assert.ok(result.includes('foo'));
  });
});

describe('Shell Tools', () => {
  it('should create all tools', () => {
    const tools = createAllTools(TEST_DIR);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(names.includes('glob'));
    assert.ok(names.includes('grep'));
    assert.ok(names.includes('bash'));
  });

  // Skip shell execution test on Windows (shell path issues)
  if (process.platform !== 'win32') {
    it('should execute shell commands', async () => {
      const tools = createShellTools(TEST_DIR);
      const bashTool = tools.find((t) => t.name === 'bash')!;

      const result = await bashTool.execute({ command: 'echo hello' });
      assert.ok(result.includes('hello'));
    });
  }
});
