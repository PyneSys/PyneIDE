import * as path from 'node:path';

export const Uri = {
  joinPath: (base: { fsPath: string }, ...parts: string[]): { fsPath: string } => ({
    fsPath: path.join(base.fsPath, ...parts),
  }),
};

export const window = {
  showQuickPick: async (): Promise<undefined> => {
    throw new Error('Unexpected security data prompt');
  },
};

export const commands = {
  executeCommand: async (): Promise<void> => {
    throw new Error('Unexpected security download');
  },
};
