# Error Reference

All errors reported by NeoSyringe — in the IDE, the CLI, and at build time.

## Stable codes (`NEO_*`)

The `NEO_*` codes are the machine-readable contract. The message text may change; the code does not. The CLI prints the code in the `code` field of each error with `--json` (`packages/cli/src/report.ts:135`). The plugin puts the code at the start of most build messages, but not all of them (the `NEO_ASYNC_TRANSIENT` message starts with the sentence, `packages/core/src/analyzer/parsers/InjectionParser.ts:217`): read the code from the CLI report when you need it.

Each code below exists in `packages/*/src`. `tests/e2e/t20-docs-examples.test.ts` checks that every code listed on this page does, and runs the ones marked "run" to see them raised.

### Reported at build time

| Code | Raised when | Run |
|------|-------------|-----|
| `NEO_CONFIG_UNSUPPORTED` | A configuration shape the build cannot read: a non-literal `runtime.profile`, `useValue` declared `owned`, `mode: 'open'` with `roots`. | yes |
| `NEO_FACTORY_DEPENDENCIES_REQUIRED` | A factory has no `dependencies` list in strict validation. In `compatible` it is a warning (the factory is opaque). | yes |
| `NEO_ASYNC_TRANSIENT` | An async factory with `lifecycle: 'transient'`. | yes |
| `NEO_DISPOSABLE_TRANSIENT_CAPTURED` | A singleton captures a disposable transient, including through a chain of non-disposable transients. A singleton with `scoped: true` is still refused. A transient consumer, including one with `scoped: true`, is not. Strict is an error. `validation: 'compatible'` is a warning only on the core analyzer (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:301`). The plugin and the CLI stay strict (`packages/unplugin/src/session.ts:559`, `packages/cli/src/index.ts:105`). | yes |
| `NEO_DUPLICATE_PROVIDER` | A simple token is registered twice, in the same container, a parent or a partial. | |
| `NEO_MISSING_PROVIDER` | A dependency is not in the view of the container. | |
| `NEO_CYCLE` | A dependency cycle. | |
| `NEO_UNKNOWN_CONTAINER` | A `resolve` whose receiver the build cannot attribute. An undecidable receiver, such as `get().createScope()`, stays this error (`packages/core/src/analyzer/collectors/resolutionUsages.ts:142`, `packages/core/src/analyzer/validators/MissingDependencyValidator.ts:136`). | yes |
| `NEO_MULTI_REQUIRES_RESOLVE_ALL` | `resolve` of a `multi` token (build time when visible, run time otherwise). | yes |
| `NEO_ROOT_NOT_EXPORTED` | `resolve` of a token outside the roots of a closed container (build time when visible, run time otherwise). | yes |
| `NEO_CLOSED_REQUIRES_STRICT` | Closed mode with `validation: 'compatible'`. | yes |
| `NEO_UNDECLARED_FACTORY_DEP` | At build time: a factory calls `resolve` or `resolveAll` directly on a captured container instead of its context (`packages/core/src/analyzer/parsers/InjectionParser.ts:584` to `:614`). The build does not see a helper or a dynamic receiver. The run time guard below catches a token outside `dependencies`. | yes |
| `NEO_TOKEN_UNSUPPORTED`, `NEO_TOKEN_COLLISION`, `NEO_TOKEN_BOUNDARY_UNSUPPORTED` | A token the build cannot identify safely, two descriptors with one key, or an external token not described by the token manifest. | |

### Thrown at run time by the generated container

| Code | Thrown when | Run |
|------|-------------|-----|
| `NEO_NOT_INITIALIZED` | `resolve` before `initialize()` finished. | yes |
| `NEO_CONTAINER_BUSY` | `resolve`, `initialize`, `destroy`, `createScope`, `override` and `clearOverrides` during a reconfiguration. `override`, `clearOverrides` and `createScope` also while `initialize()` is running. `override` and `clearOverrides` also while the container is destroying (source only: `packages/core/src/generator/LifecycleEmitter.ts:516` to `:517`). | yes |
| `NEO_CONTAINER_FAILED` | `resolve` and `createScope()` after `initialize()` rejected. `override` and `clearOverrides` too (source only: `packages/core/src/generator/LifecycleEmitter.ts:522` to `:523`). | yes |
| `NEO_CONTAINER_DESTROYED` | Use of a destroyed container (`resolve`, `initialize`, `createScope`). | yes |
| `NEO_SCOPE_PARENT_DESTROYED` | A child needs a parent that was destroyed. | yes |
| `NEO_TEST_API_DISABLED` | `override` or `clearOverrides` in a build without `testOverrides: true`. | yes |
| `NEO_OVERRIDE_MULTI_UNSUPPORTED` | `override` of a `multi` token. | yes |
| `NEO_FACTORY_CONTEXT_EXPIRED` | A factory context used after the factory returned. | yes |
| `NEO_UNDECLARED_FACTORY_DEP` | See above. | yes |
| `NEO_ROOT_NOT_EXPORTED` | See above (guard for dynamic access). | |
| `NEO_MULTI_REQUIRES_RESOLVE_ALL` | See above (guard). | |

A runtime error is an `Error` with a `code` property and a message that starts with the code.

NEO_IMPORT_UNRESOLVED appears in the correction plan but is not emitted by any package at this revision. Do not wait for it.

## Legacy numbered codes


| Code | Type | Where reported |
|------|------|----------------|
| 9995 | `missing` | Missing dependency not registered |
| 9996 | `cycle` | Circular dependency between services |
| 9997 | `type-mismatch` | Provider incompatible with token type |
| 9998 | `duplicate` | Token registered more than once |

---

## Missing Injection (9995)

A service requires a dependency that is not registered in the container.

```
Missing injection: 'IDatabase' required by 'UserService' is not registered in this builder nor its parents/extends
```

**Fix:** Register the missing token in the same container, a parent container, or a partial extended by this container.

```typescript
export const container = defineBuilderConfig({
  injections: [
    { token: useInterface<IDatabase>(), provider: PostgresDatabase }, // ← add this
    { token: UserService }
  ]
});
```

---

## Circular Dependency (9996)

Two or more services depend on each other, forming a cycle.

```
Circular dependency detected: ServiceA -> ServiceB -> ServiceA
```

**Fix:** Introduce an intermediate abstraction or restructure the dependency direction. Circular dependencies are always a design issue — there is no runtime workaround.

---

## Type Mismatch (9997)

Several situations produce this error:

### Provider does not implement the interface

```
Type mismatch: Provider 'LogService' is not assignable to token type 'IUserRepository'.
```

**Fix:** Use a provider that implements the token's interface.

---

### `useValue` with a primitive type

```
useValue cannot be used with primitive type 'string'.
Use useProperty<string>(TargetClass, 'paramName') instead.
```

**Fix:** Use [`useProperty`](../guide/injection-types#property-token) for string, number, and boolean values.

```typescript
// ❌
{ token: useInterface<string>(), useValue: 'http://localhost' }

// ✅
const apiUrl = useProperty<string>(ApiService, 'apiUrl');
{ token: apiUrl, useFactory: true, dependencies: [], provider: () => 'http://localhost' }
```

---

### `useValue` with a class token

```
useValue cannot be used with a class token. Use provider: MyClass to register a class, or useInterface<T>() with useValue for an interface token.
```

`useValue` only works for interface tokens (`useInterface<T>()`) and property tokens (`useProperty<T>()`) — both are resolved by string comparison. A class-constructor token is resolved by class identity, which a pre-built value has no way to satisfy.

**Fix:** For a plain registration, use `provider: MyClass`. For a pre-built instance under a class token, use a factory instead of `useValue`:

```typescript
// ❌ Throws TypeMismatchError
{ token: SomeConcreteClass, useValue: someInstance }

// ✅ Correct
{ token: SomeConcreteClass, provider: () => someInstance, useFactory: true, dependencies: [] }
```

---

### Async factory with `lifecycle: 'transient'`

```
Async factory for 'IDatabase' cannot use lifecycle: 'transient'.
Async factories are pre-initialized once in initialize() and must be singletons.
```

**Fix:** Remove `lifecycle: 'transient'` — async factories are always singleton.

```typescript
// ❌
{ token: useInterface<IDatabase>(), provider: async () => createPool(), useFactory: true, dependencies: [], lifecycle: 'transient' }

// ✅
{ token: useInterface<IDatabase>(), provider: async () => createPool(), useFactory: true, dependencies: [] }
```

---

## Duplicate Registration (9998)

A token is registered more than once in the same scope.

### Internal duplicate

```
Duplicate registration: 'UserService' is already registered.
```

**Fix:** Remove the duplicate, or use `scoped: true` if you intentionally want to override a parent token.

---

### Duplicate with parent container

```
Duplicate registration: 'AuthService' is already registered in parent container 'legacy'.
```

**Fix:** Use `scoped: true` to mark the override as intentional.

```typescript
{ token: AuthService, provider: NewAuthService, scoped: true }
```

---

### Duplicate with partial (extends)

```
Duplicate registration: 'LoggerService' is already registered in partial 'sharedPartial'.
```

**Fix:** Remove the registration from the local container — it is already provided by the extended partial.

---

### Mixed `multi` and non-`multi` for the same token

```
Token 'IPlugin' is registered both with and without 'multi: true'.
All registrations for a token must consistently use multi: true or not at all.
```

**Fix:** Decide whether the token is multi or single, and apply `multi: true` (or not) consistently to all registrations.

---

## Unsupported Container Shape (build time, not a coded diagnostic)

`defineBuilderConfig(...)` was called in a shape the build plugin cannot locate and replace — most commonly, returned directly from a function with no intermediate variable.

```
defineBuilderConfig() must be assigned to a variable — 'const container = defineBuilderConfig({...})'
(then `return container;` separately if inside a function) — or used as
'export default defineBuilderConfig({...})'. A bare 'return defineBuilderConfig({...})' (or any other
shape) cannot be located for replacement and would silently ship the untransformed call, which is
unsafe at runtime.
```

**Fix:** Assign the result to a `const` first, then return it:

```typescript
// ❌ Fails the build
export function buildContainer() {
  return defineBuilderConfig({ injections: [ /* ... */ ] });
}

// ✅ Works
export function buildContainer() {
  const container = defineBuilderConfig({ injections: [ /* ... */ ] });
  return container;
}
```

This used to fail silently — no error, and the raw `defineBuilderConfig()` call shipped untouched, throwing an unrelated runtime error the first time it was ever invoked. It is now caught and rejected at build time.

---

## Service Not Found (runtime, not a build-time diagnostic)

Unlike every error above, this one is thrown by the **generated container itself**, at `resolve()` time — not by the build plugin.

```
NeoServiceNotFoundError: [ContainerName] Service not found or token not registered: <token>
```

**Cause:** You called `container.resolve(token)` (or an auto-wired class depends on `token`) for a token that isn't registered in that specific container, its `useContainer` parent chain, or its `legacy` containers.

**Fix:**
- Double-check you're resolving from the right container — a token registered in a sibling module's container is not visible unless shared through `useContainer` (see [Composing Containers Across Modules](../guide/parent-container.md)).
- If this is meant to come from a parent/legacy container, confirm the token was actually registered there — a build-time "Missing injection" error would normally catch this first, but a token resolved manually at runtime (not via a typed constructor parameter) isn't checked at build time.
