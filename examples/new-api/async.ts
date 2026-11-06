import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Config {
  endpoint: string;
}

interface Client {
  endpoint: string;
  closed: boolean;
  dispose(): Promise<void>;
}

// #region container
const config = useInterface<Config>();
const client = useInterface<Client>();

let disposed = 0;

export const container = defineBuilderConfig({
  name: 'AsyncApp',
  injections: [
    { token: config, useValue: { endpoint: '/api' } },
    {
      token: client,
      useFactory: true,
      dependencies: [config],
      provider: async (context): Promise<Client> => {
        const settings = context.resolve(config);
        await Promise.resolve();
        const instance: Client = {
          endpoint: settings.endpoint,
          closed: false,
          async dispose() {
            instance.closed = true;
            disposed += 1;
          },
        };
        return instance;
      },
    },
  ],
});
// #endregion container

function codeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function run() {
  let beforeInit = 'no error';
  try {
    container.resolve(client);
  } catch (error) {
    beforeInit = codeOf(error);
  }
  await container.initialize();
  const ready = container.resolve(client);
  const endpoint = ready.endpoint;
  await container.destroy();
  await container.destroy();
  let afterDestroy = 'no error';
  try {
    container.resolve(client);
  } catch (error) {
    afterDestroy = codeOf(error);
  }
  return { beforeInit, endpoint, closed: ready.closed, disposed, afterDestroy };
}
