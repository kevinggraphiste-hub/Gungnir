import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpolateCommand, extractPlaceholders } from '../../src/commands/index.js';

describe('Commands', () => {
  describe('extractPlaceholders', () => {
    it('should extract $NAME placeholders', () => {
      const result = extractPlaceholders('Run $ISSUE_NUMBER and $AUTHOR_NAME');
      assert.deepEqual(result.sort(), ['AUTHOR_NAME', 'ISSUE_NUMBER']);
    });

    it('should extract ${NAME} placeholders', () => {
      const result = extractPlaceholders('Run ${FILE_PATH}');
      assert.deepEqual(result, ['FILE_PATH']);
    });

    it('should not extract lowercase', () => {
      const result = extractPlaceholders('Run $name and $value');
      assert.equal(result.length, 0);
    });
  });

  describe('interpolateCommand', () => {
    it('should replace $NAME', () => {
      const result = interpolateCommand('gh issue view $ISSUE', { ISSUE: '123' });
      assert.equal(result, 'gh issue view 123');
    });

    it('should replace ${NAME}', () => {
      const result = interpolateCommand('cat ${FILE}', { FILE: 'readme.md' });
      assert.equal(result, 'cat readme.md');
    });

    it('should replace multiple placeholders', () => {
      const result = interpolateCommand('$CMD $FILE', { CMD: 'cat', FILE: 'test.txt' });
      assert.equal(result, 'cat test.txt');
    });
  });
});
