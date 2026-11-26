import { defineBuilderConfig, definePartialConfig, useInterface, useProperty, type InputToken } from '@djodjonx/neosyringe';

interface Request {
  id: string;
}
interface Other {
  label: string;
}
class Handler {
  retries = 0;
}

const request = useInterface<Request>();
const other = useInterface<Other>();
const retries = useProperty<number>(Handler, 'retries');

export const requests = defineBuilderConfig({
  name: 'ScopeInputsNegative',
  scopeInputs: [request, retries],
  injections: [{ token: Handler }],
});
export const lean = defineBuilderConfig({
  name: 'ScopeInputsNegativeLean',
  runtime: { profile: 'minimal' },
  scopeInputs: [request],
  injections: [{ token: Handler }],
});

// A missing input.
requests.createScope({ values: [{ token: request, useValue: { id: '1' } }] });
// An extra input.
requests.createScope({
  values: [
    { token: request, useValue: { id: '1' } },
    { token: retries, useValue: 3 },
    { token: other, useValue: { label: '2' } },
  ],
});
// A value of the wrong type.
requests.createScope({ values: [{ token: request, useValue: 42 }, { token: retries, useValue: 3 }] });
// A union of pairs, one of them incoherent, in a widened readonly array.
declare const mixed: ReadonlyArray<
  { readonly token: typeof request; readonly useValue: Request } | { readonly token: typeof retries; readonly useValue: Request }
>;
requests.createScope({ values: mixed });
// The model resolves nothing.
requests.resolve(request);
// The minimal profile has no override on its scope.
lean.createScope({ values: [{ token: request, useValue: { id: '3' } }] }).override(Handler, () => new Handler());
// A bound scope asks for its values again.
requests.createScope({ values: [{ token: request, useValue: { id: '1' } }, { token: retries, useValue: 3 }] }).createScope();
// A list the plugin cannot read as a literal.
declare const widened: readonly InputToken[];
defineBuilderConfig({ name: 'ScopeInputsWidened', scopeInputs: widened, injections: [{ token: Handler }] });
// A class token is not a scope input.
defineBuilderConfig({ name: 'ScopeInputsClass', scopeInputs: [Handler], injections: [{ token: Handler }] });
// A partial cannot declare inputs.
definePartialConfig({ scopeInputs: [request], injections: [{ token: Handler }] });
