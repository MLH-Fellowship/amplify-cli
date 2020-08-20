import { FunctionRuntimeContributorFactory } from 'amplify-function-plugin-interface';
import { checkDependencies } from './utils/deps';

export const functionRuntimeContributorFactory: FunctionRuntimeContributorFactory = context => {
  return {
    contribute: async request => {
      if (request.selection !== 'swift') {
        throw new Error(`Unknown selection ${request.selection}`);
      }
      return {
        runtime: {
          name: 'Swift',
          value: 'swift',
          cloudTemplateValue: 'custom', // Stubbed. Not sure if this is correct?
          defaultHandler: 'index.handler', // Stubbed. Not sure if this is correct?
        },
      };
    },
    checkDependencies: async runtimeValue => checkDependencies(runtimeValue),
    package: async request => ({}), // Stubbed.
    build: async request => ({ rebuilt: false }), // Stubbed.
    invoke: async request => ({}), // Stubbed.
  };
};
