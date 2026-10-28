import { describe, it, expect } from 'vitest';
import { applySmartEdit, applySmartEditV2 } from './smartApply';

describe('applySmartEdit', () => {
	describe('no markers', () => {
		it('should return code_edit as-is when no markers present', () => {
			const existing = 'const x = 1;\nconst y = 2;';
			const edit = 'const a = 10;\nconst b = 20;';

			const result = applySmartEdit(existing, edit);
			expect(result).toBe(edit);
		});

		it('should handle empty existing content', () => {
			const existing = '';
			const edit = 'const x = 1;';

			const result = applySmartEdit(existing, edit);
			expect(result).toBe(edit);
		});
	});

	describe('with markers', () => {
		it('should preserve content before marker', () => {
			const existing = `const x = 1;
const y = 2;
const z = 3;`;

			const edit = `// ... existing code ...
const z = 3;`;

			const result = applySmartEdit(existing, edit);
			expect(result).toContain('const x = 1;');
			expect(result).toContain('const y = 2;');
			expect(result).toContain('const z = 3;');
		});

		it('should preserve content after marker', () => {
			const existing = `const x = 1;
const y = 2;
const z = 3;`;

			const edit = `const x = 1;
// ... existing code ...`;

			const result = applySmartEdit(existing, edit);
			expect(result).toContain('const x = 1;');
			expect(result).toContain('const y = 2;');
			expect(result).toContain('const z = 3;');
		});

		it('should handle marker in the middle', () => {
			const existing = `function foo() {
  const a = 1;
  const b = 2;
  const c = 3;
  return a + b + c;
}`;

			const edit = `function foo() {
  const a = 100;
  // ... existing code ...
  return a + b + c;
}`;

			const result = applySmartEdit(existing, edit);
			expect(result).toContain('const a = 100;');
			expect(result).toContain('return a + b + c;');
		});

		it('should handle multiple markers', () => {
			const existing = `import React from 'react';

function Component() {
  const [state, setState] = useState(0);

  return <div>{state}</div>;
}

export default Component;`;

			const edit = `import React from 'react';
import { useState } from 'react';

// ... existing code ...

export default Component;`;

			const result = applySmartEdit(existing, edit);
			expect(result).toContain("import { useState } from 'react';");
			expect(result).toContain('export default Component;');
		});

		it('should remove markers from output', () => {
			const existing = 'const x = 1;';
			const edit = `// ... existing code ...
const y = 2;`;

			const result = applySmartEdit(existing, edit);
			expect(result).not.toContain('// ... existing code ...');
		});

		it('should handle hash comment markers', () => {
			const existing = `x = 1
y = 2
z = 3`;

			const edit = `# ... existing code ...
z = 3`;

			const result = applySmartEdit(existing, edit);
			expect(result).toContain('x = 1');
			expect(result).toContain('y = 2');
			expect(result).toContain('z = 3');
		});

		it('should handle HTML comment markers', () => {
			const existing = `<div>
  <span>Hello</span>
  <span>World</span>
</div>`;

			const edit = `<div>
  <!-- ... existing code ... -->
  <span>World</span>
</div>`;

			const result = applySmartEdit(existing, edit);
			expect(result).toContain('<span>Hello</span>');
			expect(result).toContain('<span>World</span>');
		});
	});

	describe('edge cases', () => {
		it('should handle empty existing with markers', () => {
			const existing = '';
			const edit = `// ... existing code ...
const x = 1;`;

			const result = applySmartEdit(existing, edit);
			expect(result).toBe('const x = 1;');
		});

		it('should handle only markers', () => {
			const existing = 'const x = 1;';
			const edit = '// ... existing code ...';

			const result = applySmartEdit(existing, edit);
			expect(result).toBe(existing);
		});

		it('should preserve indentation', () => {
			const existing = `function foo() {
    const x = 1;
    const y = 2;
}`;

			const edit = `function foo() {
    const x = 100;
    // ... existing code ...
}`;

			const result = applySmartEdit(existing, edit);
			expect(result).toContain('    const x = 100;');
		});
	});
});

describe('applySmartEditV2', () => {
	it('should handle simple marker replacement', () => {
		const existing = `const a = 1;
const b = 2;
const c = 3;`;

		const edit = `const a = 1;
// ... existing code ...
const c = 3;`;

		const result = applySmartEditV2(existing, edit);
		expect(result).toContain('const a = 1;');
		expect(result).toContain('const b = 2;');
		expect(result).toContain('const c = 3;');
	});

	it('should handle additions at the beginning', () => {
		const existing = `const x = 1;
const y = 2;`;

		const edit = `const newVar = 0;
// ... existing code ...`;

		const result = applySmartEditV2(existing, edit);
		expect(result).toContain('const newVar = 0;');
		expect(result).toContain('const x = 1;');
		expect(result).toContain('const y = 2;');
	});

	it('should handle additions at the end', () => {
		const existing = `const x = 1;
const y = 2;`;

		const edit = `const x = 1;
const y = 2;
// ... existing code ...
const z = 3;`;

		const result = applySmartEditV2(existing, edit);
		expect(result).toContain('const x = 1;');
		expect(result).toContain('const y = 2;');
		expect(result).toContain('const z = 3;');
	});
});
