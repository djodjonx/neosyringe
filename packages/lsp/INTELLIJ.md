# IntelliJ IDEA Setup

## Enable TypeScript Language Service

1. Settings → Languages & Frameworks → TypeScript
2. Check "TypeScript Language Service"
3. Restart TypeScript Service

## Verify

```typescript
// Should show duplication error
export const container = defineBuilderConfig({
  injections: [
    { token: UserService },
    { token: UserService }
  ]
});
```

## Troubleshooting

- Invalidate caches: File → Invalidate Caches
- Check TypeScript Service is active
- IntelliJ Community NOT supported (use Ultimate/WebStorm)

See INTELLIJ_DIAGNOSTIC.md for full guide.
