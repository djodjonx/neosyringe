import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { CORPUS, fixtureFiles } from '../helpers/t03c1-corpus';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

function messagesOf(fixtureName: string): { message: string; file: string }[] {
  const fixture = CORPUS.find((entry) => entry.name === fixtureName);
  if (!fixture) throw new Error(`no fixture ${fixtureName}`);
  return new Analyzer(memoryProgram(fixtureFiles(fixture)))
    .extractAllErrors()
    .map((error) => ({ message: error.message, file: error.sourceFile.fileName }));
}

const APP = captureRoot('expects-alias/app.ts');
const expectation = (label: string): string =>
  `Missing token: 'Needed' is declared in '${label}.expects' but is not provided by this builder or its parent container.`;

describe('T03 C1 expects is checked for a partial extended under another name', () => {
  it('W15 an aliased import, a re-export and a namespace are each checked, and named as the user wrote them', () => {
    // Base looked the partial up by the text written in extends: an alias or a re-export name found nothing
    // and the expectation was never checked. A namespace was found and named by its declaration (basePart).
    expect(messagesOf('expects-alias')).toEqual([
      { message: expectation('shared'), file: APP },
      { message: expectation('sharedOut'), file: APP },
      { message: expectation('B.basePart'), file: APP },
    ]);
  });

  it('W15 a host that provides the expected token is clean under every spelling', () => {
    const errors = messagesOf('expects-alias').filter((item) => item.message.includes('ExpSatisfied'));
    expect(errors).toEqual([]);
  });

  it('W15 a partial extended under its own name keeps its own name in the message', () => {
    const fixture = CORPUS.find((entry) => entry.name === 'expects');
    if (!fixture) throw new Error('no fixture expects');
    const errors = new Analyzer(memoryProgram(fixtureFiles(fixture))).extractAllErrors();
    expect(errors.map((error) => error.message)).toEqual([expectation('part')]);
  });
});
