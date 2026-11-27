import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Request {
  id: string;
  tenant: string;
}

class Handler {
  constructor(readonly request: Request) {}

  describe(): string {
    return `${this.request.tenant}/${this.request.id}`;
  }
}

const request = useInterface<Request>();

// #region container
// `scopeInputs` declares what each scope receives. The builder is then a model: it makes scopes, it does not resolve.
export const requests = defineBuilderConfig({
  name: 'ScopeInputsApp',
  scopeInputs: [request],
  injections: [{ token: Handler }],
});
// #endregion container

export async function run() {
  // #region scopes
  // Each scope is given its value, checked against the token it names. No cast.
  const first = requests.createScope({ values: [{ token: request, useValue: { id: 'r1', tenant: 'acme' } }] });
  const second = requests.createScope({ values: [{ token: request, useValue: { id: 'r2', tenant: 'globex' } }] });
  const a = first.resolve(Handler);
  const b = second.resolve(Handler);
  // #endregion scopes

  const stable = first.resolve(Handler) === a;
  const read: Request = first.resolve(request);
  await first.destroy();
  await second.destroy();
  await requests.destroy();
  return { first: a.describe(), second: b.describe(), isolated: a !== b, stable, tenant: read.tenant };
}
