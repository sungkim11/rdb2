import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#101418',
        paper: '#f6f2e8',
        accent: '#d2843f',
        signal: '#7bc6a4',
        line: '#26313d',
        panel: '#131b23',
        panelAlt: '#19232d',
        muted: '#8b98a7',
      },
      boxShadow: {
        chrome: '0 20px 60px rgba(0, 0, 0, 0.28)',
      },
      borderRadius: {
        xl2: '1.25rem',
      },
      keyframes: {
        rise: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        rise: 'rise 320ms ease-out forwards',
      },
      fontFamily: {
        sans: ['"Avenir Next"', '"Segoe UI"', '"Helvetica Neue"', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SFMono-Regular"', '"Menlo"', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
