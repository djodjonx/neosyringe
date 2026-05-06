import { afterEach } from 'vitest';
import { TSContext } from '../src/TSContext';

afterEach(() => {
  TSContext.reset();
});
