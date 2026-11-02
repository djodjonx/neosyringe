import { useInterface, type Optimization } from '@djodjonx/neosyringe';

interface ClosedPort {
  ok: number;
}

const token = useInterface<ClosedPort>();

export const openWithRoots: Optimization = { mode: 'open', roots: [token] };

export const closedWithoutRoots: Optimization = { mode: 'closed' };
