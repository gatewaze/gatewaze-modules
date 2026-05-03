import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './wrappers/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      maxWidth: { content: 'var(--max-content-width)' },
    },
  },
  plugins: [],
};

export default config;
