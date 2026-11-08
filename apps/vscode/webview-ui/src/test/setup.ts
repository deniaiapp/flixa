import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { expect } from 'vitest';

GlobalRegistrator.register();

expect.extend({
	toBeInTheDocument(received: unknown) {
		const pass = received !== null && received !== undefined;
		return {
			pass,
			message: () =>
				pass
					? `expected element not to be in the document`
					: `expected element to be in the document`,
		};
	},
});
