import { describe, expect, it } from 'vitest';
import { linkAliases, orderingDependencies, type AliasPlan } from '../../src/analyzer/shared/aliasLinks';

/**
 * The walk that flattens a chain of aliases (adapted from the reference core of topic 20): a chain of any length is one
 * pass with no recursion, and everything the analysis would refuse is refused with the reference message.
 */

describe('E20 alias links', () => {
  it('E20-P3 a chain of 50000 aliases is flattened in one pass, whatever the order of the entries', () => {
    const size = 50_000;
    const forward: Array<readonly [string, string]> = Array.from({ length: size }, (_, index) => [`A_${index}`, index === 0 ? 'T' : `A_${index - 1}`]);
    const providers = new Set(['T']);
    const links = linkAliases(providers, forward);
    expect(links.targetOf('A_49999'), 'forward').toBe('T');
    expect(links.targetOf('A_0')).toBe('T');
    const reversed = linkAliases(providers, [...forward].reverse());
    expect(reversed.targetOf('A_49999'), 'reversed: the first walk covers the whole chain').toBe('T');
    expect(reversed.targetOf('T'), 'a provider is its own target').toBe('T');
  });

  it('E20-W1 an alias registered twice, or a token that is a provider and an alias, is refused', () => {
    const providers = new Set(['T']);
    expect(() => linkAliases(providers, [['A', 'T'], ['A', 'T']])).toThrow('duplicate alias registration');
    expect(() => linkAliases(providers, [['T', 'T']])).toThrow('duplicate alias registration');
  });

  it('E20-W2 aliases that point at each other are a cycle', () => {
    expect(() => linkAliases(new Set(['T']), [['A', 'B'], ['B', 'A']])).toThrow('alias cycle');
    expect(() => linkAliases(new Set(['T']), [['A', 'A']])).toThrow('alias cycle');
  });

  it('E20-W3 a target nothing provides and nothing aliases is missing', () => {
    expect(() => linkAliases(new Set(['T']), [['A', 'B']])).toThrow('missing alias target');
  });

  it('E20-W4 a token that is neither a provider nor an alias is unknown', () => {
    const links = linkAliases(new Set(['T']), [['A', 'T']]);
    expect(() => links.targetOf('nobody')).toThrow('unknown alias token');
  });

  it('E20-W5 an ordering reads the canonical target of an alias dependency, and nothing else', () => {
    const plan: AliasPlan = {
      isAlias: (token) => token === 'A',
      canonicalOf: () => 'T',
      isLocal: () => true,
      localTargets: new Set(['T']),
    };
    expect(orderingDependencies(plan, ['A', 'B'])).toEqual(['T', 'B']);
    expect(orderingDependencies(undefined, ['A', 'B'])).toEqual(['A', 'B']);
  });
});
